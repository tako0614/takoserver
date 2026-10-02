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

// Native-only: run inside an isolated network namespace with loopback enabled.
// The real Bun entry owns both listeners; 443 is required by WorkerEndpoint@0.1.0.
const WORKERD = nativeEvidenceBinary("workerd-artifact") ?? null;
const HOST_ORIGIN = "http://127.0.0.1:8787";
const API_PORT = 8787;
const CORE_VERIFIER_PORT = 8080;
const CORE_VERIFIER_ORIGIN = `http://127.0.0.1:${CORE_VERIFIER_PORT}`;
const WORKER_SUFFIX = "apps.selfhost.test";
const LANE = "/apis/forms.takoform.com/v1";
const SPACE = "default";
const WORKER_MARKER_V1 = "cold-restore-marker-v1";
const WORKER_MARKER_V2 = "cold-restore-marker-v2";
const MODULE_V1 = `export default { async fetch() { return new Response("${WORKER_MARKER_V1}"); } };`;
const MODULE_V2 = `export default { async fetch() { return new Response("${WORKER_MARKER_V2}"); } };`;
const RESOURCE_NAMES = [
  ["ModuleWorker", "cold-restore-worker"],
  ["WorkerBundle", "cold-restore-bundle"],
  ["WorkerVersion", "cold-restore-version"],
  ["WorkerBundle", "cold-restore-bundle-v2"],
  ["WorkerVersion", "cold-restore-version-v2"],
  ["WorkerDeployment", "cold-restore-deployment"],
  ["WorkerEndpoint", "cold-restore-endpoint"],
] as const;
const RESOURCE_DELETE_ORDER = [
  ["WorkerEndpoint", "cold-restore-endpoint"],
  ["WorkerDeployment", "cold-restore-deployment"],
  ["WorkerVersion", "cold-restore-version-v2"],
  ["WorkerBundle", "cold-restore-bundle-v2"],
  ["WorkerVersion", "cold-restore-version"],
  ["WorkerBundle", "cold-restore-bundle"],
  ["ModuleWorker", "cold-restore-worker"],
] as const;

type Json = Record<string, unknown>;
type Host = ReturnType<typeof startHost>;
type NativeDiagnosticPhase =
  | "core_verifier_build"
  | "core_verifier_spawn"
  | "core_identity"
  | "core_publisher_set"
  | "initial_host_ready"
  | "operator_session"
  | "organization_create"
  | "api_key_create"
  | "form_admission"
  | "post_admission_host_ready"
  | "form_discovery"
  | "v1_artifact_start_headers"
  | "v1_artifact_start_body"
  | "v1_artifact_blob"
  | "v1_artifact_commit_headers"
  | "v1_artifact_commit_body"
  | "v1_module_worker_apply"
  | "v1_bundle_apply"
  | "v1_version_apply"
  | "v1_deployment_apply"
  | "v1_endpoint_apply"
  | "v1_worker_https"
  | "pre_v2_worker_confirmed"
  | "v2_start_headers"
  | "v2_start_body"
  | "restored_host_ready";
type NativeDiagnosticOutcome = "started" | "ok" | "timeout" | "error";
type NativeDiagnosticTrace = {
  readonly mark: (phase: NativeDiagnosticPhase, outcome: NativeDiagnosticOutcome) => void;
};
type ProcessIdentity = {
  readonly pid: number;
  readonly startTicks: string;
  readonly executable: string;
};
const observedHostDescendants = new WeakMap<Host, Map<string, ProcessIdentity>>();

test.skipIf(WORKERD === null)(
  "a self-host updates, recovers, and restores its Worker at the same endpoint",
  async () => {
    await assertIsolatedSelfhostNativeEnvironment({
      fixedPorts: [API_PORT, CORE_VERIFIER_PORT, 443],
    });
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
    const coreVerifierArtifactDigest = takoformCoreVerifierArtifactDigest();
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
    let verifier: ReturnType<typeof Bun.spawn> | undefined;
    let primaryFailure: unknown;
    let hasPrimaryFailure = false;
    const cleanupFailures: string[] = [];
    const diagnosticStartedAt = performance.now();
    const diagnosticTrace: NativeDiagnosticTrace = {
      mark(phase, outcome) {
        try {
          console.log(
            `[selfhost-cold-restore] phase=${phase} outcome=${outcome} elapsed_ms=${Math.round(performance.now() - diagnosticStartedAt)}`,
          );
        } catch {
          // Native diagnostic output is best-effort and must not affect the journey.
        }
      },
    };
    try {
      const coreVerifierBinary = await runDiagnosticStage(
        diagnosticTrace,
        "core_verifier_build",
        () => buildRealCoreVerifier(join(fixture, "core-verifier")),
      );
      verifier = await runDiagnosticStage(diagnosticTrace, "core_verifier_spawn", () =>
        Bun.spawn([coreVerifierBinary], {
          cwd: process.cwd(),
          env: {
            ...baseEnvironment,
            TAKOFORM_CORE_VERIFIER_ARTIFACT_DIGEST: coreVerifierArtifactDigest,
          },
          stdin: "ignore",
          stdout: "ignore",
          stderr: "ignore",
        }),
      );
      await runDiagnosticStage(diagnosticTrace, "core_identity", () =>
        waitForCoreVerifier(verifier as Host, coreVerifierArtifactDigest),
      );
      host = await runDiagnosticStage(diagnosticTrace, "initial_host_ready", async () => {
        await createTls(sourceTls);
        const startedHost = startHost(hostEnvironment(sourceRoot, sourceDb, sourceTls));
        host = startedHost;
        await assertIsolatedSelfhostNativeEnvironment({ fixedPorts: [], ownedChild: startedHost });
        await waitForHost(startedHost, `${HOST_ORIGIN}/.well-known/takoform/v1`);
        return startedHost;
      });

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
      const session = await runDiagnosticStage(diagnosticTrace, "operator_session", () =>
        api<Json>("POST", "/v1/sessions", 200, {
          provider: "google",
          method: "operator-assertion",
          assertion,
          sessionTtlSeconds: 60,
        }),
      );
      const sessionToken = stringAt(session, "sessionToken");
      const created = await runDiagnosticStage(diagnosticTrace, "organization_create", () =>
        api<Json>(
          "POST",
          "/v1/organizations",
          201,
          { name: "Self-host cold restore" },
          { authorization: `Bearer ${sessionToken}` },
        ),
      );
      const organization = objectAt(created, "organization");
      const organizationId = stringAt(organization, "id");
      const apiKeyResponse = await runDiagnosticStage(diagnosticTrace, "api_key_create", () =>
        api<Json>(
          "POST",
          `/v1/organizations/${encodeURIComponent(organizationId)}/api-keys`,
          201,
          {
            name: "cold-restore-native",
            scopes: ["resources:read", "resources:write"],
            expiresInSeconds: 600,
          },
          { authorization: `Bearer ${sessionToken}` },
        ),
      );
      const apiToken = stringAt(apiKeyResponse, "secret");
      const auth = {
        authorization: `Bearer ${apiToken}`,
        "takoform-organization": organizationId,
      };
      async function publishModuleArtifact(
        moduleSource: string,
        key: string,
        trace?: NativeDiagnosticTrace,
        scope?: "v1" | "v2",
      ): Promise<string> {
        const moduleBytes = new TextEncoder().encode(moduleSource);
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
          { ...auth, "idempotency-key": `${key}-upload` },
          trace,
          scope === "v1"
            ? { headers: "v1_artifact_start_headers", body: "v1_artifact_start_body" }
            : undefined,
        );
        const uploadId = stringAt(upload, "uploadId");
        expect(upload.missingBlobs).toContain(moduleDigest);
        if (scope === "v1") {
          await runDiagnosticStage(trace, "v1_artifact_blob", async () => {
            const uploaded = await fetch(
              `${HOST_ORIGIN}${LANE}/artifacts/uploads/${uploadId}/blobs/${moduleDigest}`,
              { method: "PUT", headers: auth, body: moduleBytes },
            );
            expect(uploaded.status).toBe(201);
            await uploaded.arrayBuffer();
          });
        } else {
          const uploaded = await fetch(
            `${HOST_ORIGIN}${LANE}/artifacts/uploads/${uploadId}/blobs/${moduleDigest}`,
            { method: "PUT", headers: auth, body: moduleBytes },
          );
          expect(uploaded.status).toBe(201);
          await uploaded.arrayBuffer();
        }
        const artifact = await api<Json>(
          "POST",
          `${LANE}/artifacts/uploads/${uploadId}/commit`,
          201,
          undefined,
          { ...auth, "idempotency-key": `${key}-commit` },
          scope === "v1" ? trace : undefined,
          scope === "v1"
            ? { headers: "v1_artifact_commit_headers", body: "v1_artifact_commit_body" }
            : undefined,
        );
        return stringAt(artifact, "manifestDigest");
      }

      // Self-host Forms are durably admitted before Worker resources are created.
      // Exercise released Core directly before Host records any Form admission.
      await stopHost(host, { requireWorker: false, dataRoot: sourceRoot });
      host = undefined;
      await runDiagnosticStage(diagnosticTrace, "core_publisher_set", async () => {
        const publisherSetClosure = await loadPublisherSetClosure();
        await proveRealCorePublisherSet(CORE_VERIFIER_ORIGIN, publisherSetClosure);
      });
      await runDiagnosticStage(diagnosticTrace, "form_admission", async () => {
        try {
          const spawnedAdmission = Bun.spawn(
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
              env: hostEnvironment(sourceRoot, sourceDb, sourceTls),
              stdin: "ignore",
              stdout: "pipe",
              stderr: "ignore",
            },
          );
          admission = spawnedAdmission;
          const completedAdmission = spawnedAdmission;
          const admissionDescendants = new Map<string, ProcessIdentity>();
          const admissionDeadline = Date.now() + 120_000;
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
          if (!(completedAdmission.stdout instanceof ReadableStream)) {
            throw new Error("selfhost_form_admission_stdout_unavailable");
          }
          const admissionOutput = await new Response(completedAdmission.stdout).text();
          rememberDescendants(completedAdmission.pid, admissionDescendants);
          await waitForProcessIdentitiesGone(admissionDescendants.values());
          admission = undefined;
          if (exitCode !== 0) throw new Error("selfhost_form_admission_cli_nonzero_exit");
          expect(admissionOutput).toMatch(
            /^apply: converged \([1-9]\d* receipt\(s\), released-core\)$/m,
          );
        } finally {
          if (admission) await stopAdmissionProcess(admission);
          admission = undefined;
        }
      });

      host = await runDiagnosticStage(diagnosticTrace, "post_admission_host_ready", async () => {
        const startedHost = startHost(hostEnvironment(sourceRoot, sourceDb, sourceTls));
        host = startedHost;
        await assertIsolatedSelfhostNativeEnvironment({ fixedPorts: [], ownedChild: startedHost });
        await waitForHost(startedHost, `${HOST_ORIGIN}/.well-known/takoform/v1`);
        return startedHost;
      });
      const discovery = await runDiagnosticStage(diagnosticTrace, "form_discovery", () =>
        api<Json>("GET", `${LANE}/forms?space=${SPACE}`, 200, undefined, auth),
      );
      const forms = new Map(
        (discovery.forms as Json[]).map((form) => {
          const identity = objectAt(form, "identity");
          return [stringAt(objectAt(identity, "formRef"), "kind"), objectAt(identity, "formRef")];
        }),
      );
      const manifestDigestV1 = await publishModuleArtifact(
        MODULE_V1,
        "cold-restore-v1",
        diagnosticTrace,
        "v1",
      );

      const reference = (kind: string, name: string) => ({
        apiVersion: "edge.forms.takoform.com",
        kind,
        name,
      });
      async function apply(
        kind: string,
        name: string,
        spec: Json,
        options: {
          readonly expectedGeneration?: string;
          readonly ifMatchRevision?: string;
        } = {},
      ): Promise<Json> {
        const formRef = forms.get(kind);
        if (!formRef) throw new Error(`selfhost_form_missing_${kind}`);
        const desired = {
          apiVersion: formRef.apiVersion,
          kind,
          form: { formRef },
          metadata: { name, space: SPACE },
          spec,
        };
        const updating = options.ifMatchRevision !== undefined;
        if (updating !== (options.expectedGeneration !== undefined)) {
          throw new Error("selfhost_update_generation_and_revision_fence_required");
        }
        const prepared = await api<Json>("POST", `${LANE}/resources/prepare`, 200, desired, {
          ...auth,
          ...(updating
            ? { "takoform-expected-generation": options.expectedGeneration as string }
            : {}),
        });
        const review = objectAt(prepared, "review");
        const query = new URLSearchParams({
          space: SPACE,
          definitionVersion: String(formRef.definitionVersion),
          schemaDigest: String(formRef.schemaDigest),
        });
        return api<Json>(
          "PUT",
          `${LANE}/resources/${formRef.apiVersion}/${kind}/${name}?${query}`,
          updating ? 200 : 201,
          { ...desired, review },
          {
            ...auth,
            "idempotency-key": `${kind}-${name}-${updating ? "update" : "create"}`,
            ...(updating
              ? {
                  "if-match": `"${options.ifMatchRevision}"`,
                  "takoform-expected-generation": options.expectedGeneration as string,
                }
              : { "if-none-match": "*" }),
          },
        );
      }

      const moduleWorkerV1 = await runDiagnosticStage(
        diagnosticTrace,
        "v1_module_worker_apply",
        () => apply("ModuleWorker", "cold-restore-worker", {}),
      );
      await runDiagnosticStage(diagnosticTrace, "v1_bundle_apply", () =>
        apply("WorkerBundle", "cold-restore-bundle", { manifestDigest: manifestDigestV1 }),
      );
      await runDiagnosticStage(diagnosticTrace, "v1_version_apply", () =>
        apply("WorkerVersion", "cold-restore-version", {
          worker: reference("ModuleWorker", "cold-restore-worker"),
          bundle: reference("WorkerBundle", "cold-restore-bundle"),
          handlers: ["fetch"],
          requiredSensitiveVars: [],
        }),
      );
      const deploymentV1 = await runDiagnosticStage(diagnosticTrace, "v1_deployment_apply", () =>
        apply("WorkerDeployment", "cold-restore-deployment", {
          worker: reference("ModuleWorker", "cold-restore-worker"),
          versions: [
            {
              workerVersion: reference("WorkerVersion", "cold-restore-version"),
              weight: 10_000,
            },
          ],
        }),
      );
      const endpointResource = await runDiagnosticStage(diagnosticTrace, "v1_endpoint_apply", () =>
        apply("WorkerEndpoint", "cold-restore-endpoint", {
          worker: reference("ModuleWorker", "cold-restore-worker"),
        }),
      );
      const endpointBefore = output(endpointResource, "url");
      expect(new URL(endpointBefore).protocol).toBe("https:");
      expect(new URL(endpointBefore).port).toBe("");
      const hostname = new URL(endpointBefore).hostname;
      const markerBefore = await runDiagnosticStage(diagnosticTrace, "v1_worker_https", () =>
        workerRequest(hostname, join(sourceTls, "worker-cert.pem"), "/"),
      );
      expect(markerBefore).toBe(WORKER_MARKER_V1);
      diagnosticTrace.mark("pre_v2_worker_confirmed", "ok");

      // Publish V2 through the same public artifact and Form endpoints, then
      // update the existing Deployment behind its current revision fence.
      const manifestDigestV2 = await publishModuleArtifact(
        MODULE_V2,
        "cold-restore-v2",
        diagnosticTrace,
      );
      await apply("WorkerBundle", "cold-restore-bundle-v2", {
        manifestDigest: manifestDigestV2,
      });
      await apply("WorkerVersion", "cold-restore-version-v2", {
        worker: reference("ModuleWorker", "cold-restore-worker"),
        bundle: reference("WorkerBundle", "cold-restore-bundle-v2"),
        handlers: ["fetch"],
        requiredSensitiveVars: [],
      });
      const deploymentV2 = await apply(
        "WorkerDeployment",
        "cold-restore-deployment",
        {
          worker: reference("ModuleWorker", "cold-restore-worker"),
          versions: [
            {
              workerVersion: reference("WorkerVersion", "cold-restore-version-v2"),
              weight: 10_000,
            },
          ],
        },
        {
          expectedGeneration: stringAt(objectAt(deploymentV1, "metadata"), "generation"),
          ifMatchRevision: stringAt(objectAt(deploymentV1, "metadata"), "revision"),
        },
      );
      expect(stringAt(objectAt(deploymentV2, "metadata"), "uid")).toBe(
        stringAt(objectAt(deploymentV1, "metadata"), "uid"),
      );
      expect(stringAt(objectAt(deploymentV2, "metadata"), "revision")).not.toBe(
        stringAt(objectAt(deploymentV1, "metadata"), "revision"),
      );
      expect(await workerRequest(hostname, join(sourceTls, "worker-cert.pem"), "/")).toBe(
        WORKER_MARKER_V2,
      );
      rememberHostDescendants(host);
      const graphBefore = await readResourceGraph(auth, forms);
      expect(
        stringAt(resourceGraphItem(graphBefore, "ModuleWorker", "cold-restore-worker"), "uid"),
      ).toBe(stringAt(objectAt(moduleWorkerV1, "metadata"), "uid"));
      expect(
        stringAt(resourceGraphItem(graphBefore, "WorkerEndpoint", "cold-restore-endpoint"), "uid"),
      ).toBe(stringAt(objectAt(endpointResource, "metadata"), "uid"));
      expect(
        stringAt(
          objectAt(
            resourceGraphItem(graphBefore, "WorkerEndpoint", "cold-restore-endpoint"),
            "outputs",
          ),
          "url",
        ),
      ).toBe(endpointBefore);
      expect(
        stringAt(
          resourceGraphItem(graphBefore, "WorkerDeployment", "cold-restore-deployment"),
          "uid",
        ),
      ).toBe(stringAt(objectAt(deploymentV2, "metadata"), "uid"));
      const activeDeploymentSpec = objectAt(
        resourceGraphItem(graphBefore, "WorkerDeployment", "cold-restore-deployment"),
        "spec",
      );
      if (
        !Array.isArray(activeDeploymentSpec.versions) ||
        activeDeploymentSpec.versions.length !== 1
      ) {
        throw new Error("selfhost_updated_deployment_version_graph_invalid");
      }
      expect(
        stringAt(objectAt(activeDeploymentSpec.versions[0] as Json, "workerVersion"), "name"),
      ).toBe("cold-restore-version-v2");

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
        WORKER_MARKER_V2,
      );
      expect(recoveredMarker).toBe(WORKER_MARKER_V2);

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
      host = await runDiagnosticStage(diagnosticTrace, "restored_host_ready", async () => {
        const startedHost = startHost(hostEnvironment(restoredRoot, restoredDb, restoredTls));
        host = startedHost;
        await assertIsolatedSelfhostNativeEnvironment({ fixedPorts: [], ownedChild: startedHost });
        await waitForHost(startedHost, `${HOST_ORIGIN}/.well-known/takoform/v1`);
        return startedHost;
      });
      const restoredHostIdentity = processIdentity(host.pid);
      expect(await workerRequest(hostname, join(restoredTls, "worker-cert.pem"), "/")).toBe(
        WORKER_MARKER_V2,
      );
      const graphAfter = await readResourceGraph(auth, forms);
      expect(graphAfter).toEqual(graphBefore);
      const endpointAfter = stringAt(
        objectAt(
          resourceGraphItem(graphAfter, "WorkerEndpoint", "cold-restore-endpoint"),
          "outputs",
        ),
        "url",
      );
      expect(endpointAfter).toBe(endpointBefore);

      // Delete through the public Host API in reverse dependency order. Each
      // delete uses generation/revision read from the same public resource GET.
      for (const [kind, name] of RESOURCE_DELETE_ORDER) {
        await deleteResource(
          auth,
          forms,
          kind,
          name,
          stringAt(resourceGraphItem(graphAfter, kind, name), "uid"),
        );
      }
      await waitForWorkerEndpointRemoval(
        host,
        restoredHostIdentity,
        hostname,
        join(restoredTls, "worker-cert.pem"),
        WORKER_MARKER_V2,
      );
    } catch (error) {
      primaryFailure = error;
      hasPrimaryFailure = true;
    } finally {
      if (admission) {
        try {
          await stopAdmissionProcess(admission);
          admission = undefined;
        } catch {
          cleanupFailures.push("admission_stop_failed");
        }
      }
      if (verifier) {
        try {
          await stopVerifierProcess(verifier);
          verifier = undefined;
        } catch {
          cleanupFailures.push("verifier_stop_failed");
        }
      }
      if (host) {
        try {
          await cleanupHost(host);
          host = undefined;
        } catch {
          cleanupFailures.push("host_stop_failed");
        }
      }
    }
    finishColdRestore(primaryFailure, hasPrimaryFailure, cleanupFailures, () =>
      rmSync(fixture, { recursive: true, force: true }),
    );
  },
  240_000,
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

async function waitForCoreVerifier(
  verifier: ReturnType<typeof Bun.spawn>,
  artifactDigest: string,
): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (verifier.exitCode !== null) {
      throw new Error(`selfhost_real_core_verifier_exited_${await verifier.exited}`);
    }
    try {
      const response = await fetch(`${CORE_VERIFIER_ORIGIN}/v1/identity`);
      if (response.ok) {
        const identity = (await response.json()) as Json;
        if (
          identity.protocol === "takoserver.takoform-core-verifier@v1" &&
          identity.coreVersion === "v1.1.0" &&
          identity.coreCommit === "e0e48b864de2a127a255cb0574d37bbb0f1cac29" &&
          identity.artifactDigest === artifactDigest
        ) {
          return;
        }
        throw new Error("selfhost_real_core_verifier_identity_mismatch");
      }
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === "selfhost_real_core_verifier_identity_mismatch"
      ) {
        throw error;
      }
    }
    await Bun.sleep(25);
  }
  throw new Error("selfhost_real_core_verifier_startup_timeout");
}

async function proveRealCorePublisherSet(
  verifierOrigin: string,
  closure: Awaited<ReturnType<typeof loadPublisherSetClosure>>,
): Promise<void> {
  const endpoint = `${verifierOrigin}/v1/verify-set`;
  const request = await realCoreVerificationRequest(closure);
  const accepted = await postCoreVerification(endpoint, request);
  expect(accepted.status).toBe(200);
  const acceptedBody = (await accepted.json()) as Json;
  expect((acceptedBody.packages as unknown[]).length).toBe(closure.identity.packageCount);
  expect(closure.identity.packageCount).toBe(17);
  expect(objectAt(acceptedBody, "identity").coreVersion).toBe("v1.1.0");
  expect(objectAt(acceptedBody, "identity").coreCommit).toBe(
    "e0e48b864de2a127a255cb0574d37bbb0f1cac29",
  );

  const packageTampered = structuredClone(request);
  const packages = packageTampered.packages as Json[];
  const firstPackage = packages[0];
  const files = firstPackage?.files;
  if (!Array.isArray(files) || !files[0]) {
    throw new Error("selfhost_core_test_package_bytes_missing");
  }
  const firstFile = files[0] as Json;
  const mutatedPackageBytes = Uint8Array.from(atob(stringAt(firstFile, "bytes")), (value) =>
    value.charCodeAt(0),
  );
  if (mutatedPackageBytes.byteLength === 0) {
    throw new Error("selfhost_core_test_package_bytes_empty");
  }
  mutatedPackageBytes[0] = (mutatedPackageBytes[0] as number) ^ 1;
  files[0] = { ...firstFile, bytes: toBase64(mutatedPackageBytes) };
  await expectCoreVerificationRefused(endpoint, packageTampered);

  const publisherTampered = structuredClone(request);
  const policyBytes = Uint8Array.from(
    atob(stringAt(publisherTampered, "publisherPolicy")),
    (value) => value.charCodeAt(0),
  );
  const policy = JSON.parse(new TextDecoder().decode(policyBytes)) as Json;
  policy.ref = "refs/heads/release";
  publisherTampered.publisherPolicy = toBase64(new TextEncoder().encode(JSON.stringify(policy)));
  await expectCoreVerificationRefused(endpoint, publisherTampered);
}

async function postCoreVerification(endpoint: string, request: Json): Promise<Response> {
  return fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request),
  });
}

async function expectCoreVerificationRefused(endpoint: string, request: Json): Promise<void> {
  const response = await postCoreVerification(endpoint, request);
  expect(response.status).toBe(422);
  expect(response.headers.get("content-type")).toContain("application/json");
  const body = (await response.json()) as Json;
  expect(body.code).toBe("verification_refused");
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.byteLength; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

async function stopVerifierProcess(verifier: ReturnType<typeof Bun.spawn>): Promise<void> {
  if (verifier.exitCode === null) {
    verifier.kill("SIGTERM");
    const exitCode = await Promise.race([verifier.exited, Bun.sleep(5_000).then(() => null)]);
    if (exitCode === null) {
      verifier.kill("SIGKILL");
      await verifier.exited;
    }
  }
  await waitForPortClosed(CORE_VERIFIER_PORT);
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

async function api<T = Json>(
  method: string,
  path: string,
  expectedStatus: number,
  body?: unknown,
  headers: Record<string, string> = {},
  trace?: NativeDiagnosticTrace,
  tracePhases: {
    readonly headers: NativeDiagnosticPhase;
    readonly body: NativeDiagnosticPhase;
  } = { headers: "v2_start_headers", body: "v2_start_body" },
): Promise<T> {
  const request = () =>
    fetch(`${HOST_ORIGIN}${path}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(10_000),
    });
  const response = trace
    ? await runDiagnosticStage(trace, tracePhases.headers, request)
    : await request();
  if (response.status !== expectedStatus) {
    let code = "unknown";
    try {
      const readPayload = () => response.json() as Promise<{ readonly error?: unknown }>;
      const payload = trace
        ? await runDiagnosticStage(trace, tracePhases.body, readPayload)
        : await readPayload();
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
  if (response.status === 204) return undefined as T;
  const readBody = () => response.json() as Promise<T>;
  return trace ? await runDiagnosticStage(trace, tracePhases.body, readBody) : await readBody();
}

async function runDiagnosticStage<T>(
  trace: NativeDiagnosticTrace | undefined,
  phase: NativeDiagnosticPhase,
  operation: () => T | Promise<T>,
): Promise<T> {
  if (!trace) return await operation();
  markNativeDiagnostic(trace, phase, "started");
  try {
    const result = await operation();
    markNativeDiagnostic(trace, phase, "ok");
    return result;
  } catch (error) {
    markNativeDiagnostic(
      trace,
      phase,
      error instanceof Error && error.name === "TimeoutError" ? "timeout" : "error",
    );
    throw error;
  }
}

function markNativeDiagnostic(
  trace: NativeDiagnosticTrace,
  phase: NativeDiagnosticPhase,
  outcome: NativeDiagnosticOutcome,
): void {
  try {
    trace.mark(phase, outcome);
  } catch {
    // Observer failure must never skip work, replace success, or mask the cause.
  }
}

test("self-host diagnostic observer failures do not change stage results", async () => {
  const observed: Array<[NativeDiagnosticPhase, NativeDiagnosticOutcome]> = [];
  const trace: NativeDiagnosticTrace = {
    mark(phase, outcome) {
      observed.push([phase, outcome]);
      throw new Error("diagnostic output unavailable");
    },
  };
  const value = { completed: true };
  let operationCount = 0;

  const result = await runDiagnosticStage(trace, "core_identity", () => {
    operationCount += 1;
    return value;
  });

  expect(result).toBe(value);
  expect(operationCount).toBe(1);
  expect(observed).toEqual([
    ["core_identity", "started"],
    ["core_identity", "ok"],
  ]);

  observed.length = 0;
  const originalError = new Error("stage failed");
  let caught: unknown;
  try {
    await runDiagnosticStage(trace, "form_admission", () => Promise.reject(originalError));
  } catch (error) {
    caught = error;
  }

  expect(caught).toBe(originalError);
  expect(observed).toEqual([
    ["form_admission", "started"],
    ["form_admission", "error"],
  ]);
});

test("self-host fixture removal failure preserves the primary test failure", () => {
  const primaryFailure = new Error("selfhost_native_primary_failure");
  const cleanupFailures: string[] = [];
  let observedFailure: unknown;

  try {
    finishColdRestore(primaryFailure, true, cleanupFailures, () => {
      throw new Error("fixture removal detail must not replace the primary failure");
    });
  } catch (error) {
    observedFailure = error;
  }

  expect(observedFailure).toBeInstanceOf(Error);
  expect((observedFailure as Error).message).toBe(
    "selfhost_cleanup_failed_fixture_remove_failed_after_primary_failure",
  );
  expect((observedFailure as Error).cause).toBe(primaryFailure);
  expect(cleanupFailures).toEqual(["fixture_remove_failed"]);
});

test("self-host stop failure retains fixture and primary cause", () => {
  const primaryFailure = new Error("selfhost_native_primary_failure");
  const cleanupFailures = ["host_stop_failed"];
  let removedFixture = false;
  let observedFailure: unknown;

  try {
    finishColdRestore(primaryFailure, true, cleanupFailures, () => {
      removedFixture = true;
    });
  } catch (error) {
    observedFailure = error;
  }

  expect(removedFixture).toBe(false);
  expect((observedFailure as Error).message).toBe(
    "selfhost_cleanup_failed_host_stop_failed_after_primary_failure",
  );
  expect((observedFailure as Error).cause).toBe(primaryFailure);
});

test("self-host cleanup without secondary failures rethrows the original error", () => {
  const primaryFailure = new Error("selfhost_native_primary_failure");
  let observedFailure: unknown;

  try {
    finishColdRestore(primaryFailure, true, [], () => undefined);
  } catch (error) {
    observedFailure = error;
  }

  expect(observedFailure).toBe(primaryFailure);
});

function finishColdRestore(
  primaryFailure: unknown,
  hasPrimaryFailure: boolean,
  cleanupFailures: string[],
  removeFixture: () => void,
): void {
  if (cleanupFailures.length === 0) {
    try {
      removeFixture();
    } catch {
      cleanupFailures.push("fixture_remove_failed");
    }
  }
  if (cleanupFailures.length > 0) {
    const suffix = hasPrimaryFailure ? "after_primary_failure" : "without_primary_failure";
    throw new Error(
      `selfhost_cleanup_failed_${cleanupFailures.join("_")}_${suffix}`,
      hasPrimaryFailure ? { cause: primaryFailure } : undefined,
    );
  }
  if (hasPrimaryFailure) throw primaryFailure;
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
  const query = new URLSearchParams({
    space: SPACE,
    definitionVersion: stringAt(formRef, "definitionVersion"),
    schemaDigest: stringAt(formRef, "schemaDigest"),
  });
  const path = `${LANE}/resources/${stringAt(formRef, "apiVersion")}/${kind}/${name}?${query}`;
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
      spec: objectAt(resource, "spec"),
      ...(status.outputs === undefined ? {} : { outputs: objectValue(status.outputs, "outputs") }),
    });
  }
  return resources;
}

function resourceGraphItem(graph: readonly Json[], kind: string, name: string): Json {
  const found = graph.find((item) => item.kind === kind && item.name === name);
  if (!found) throw new Error(`selfhost_resource_missing_${kind}`);
  return found;
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

async function waitForWorkerEndpointRemoval(
  host: Host,
  hostIdentity: ProcessIdentity,
  hostname: string,
  certificatePath: string,
  expectedMarker: string,
): Promise<void> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    assertHostStillSameProcess(host, hostIdentity);
    rememberHostDescendants(host);
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) throw new Error("selfhost_worker_endpoint_removal_timeout");
    try {
      const response = await workerResponseAttempt(
        hostname,
        certificatePath,
        "/",
        Math.min(5_000, remainingMs),
      );
      assertHostStillSameProcess(host, hostIdentity);
      rememberHostDescendants(host);
      if (response.status === 404) {
        if (response.body !== `no worker is published for ${hostname}\n`) {
          throw new Error("selfhost_worker_endpoint_removal_response_unexpected");
        }
        return;
      }
      if (response.status !== 200 || response.body !== expectedMarker) {
        throw new Error(`selfhost_worker_endpoint_removal_status_${response.status}`);
      }
    } catch (error) {
      if (
        !(error instanceof WorkerHttpsTransportFailure) ||
        !RETRYABLE_WORKER_HTTPS_FAILURES.has(error.kind)
      ) {
        throw error;
      }
    }
    const retryDelayMs = Math.min(50, deadline - Date.now());
    if (retryDelayMs <= 0) throw new Error("selfhost_worker_endpoint_removal_timeout");
    await Bun.sleep(retryDelayMs);
  }
}

function workerResponseAttempt(
  hostname: string,
  certificatePath: string,
  path: string,
  timeoutMs: number,
): Promise<{ readonly status: number; readonly body: string }> {
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
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer | string) => chunks.push(Buffer.from(chunk)));
        response.on("error", () => {
          clearDeadline();
          reject(new Error("worker_https_response_error"));
        });
        response.on("end", () => {
          clearDeadline();
          resolve({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          });
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
  expectedMarker: string,
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
      if (marker !== expectedMarker) throw new Error("selfhost_worker_marker_unexpected");
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
