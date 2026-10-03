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
import { createStaticTestTakoformHost } from "../src/app.ts";
import { createEphemeralSql } from "../src/compat.ts";
import { bytesDigest } from "../src/json.ts";
import { createMemoryObjectStore } from "../src/objects-mem.ts";
import { signOperatorAssertion } from "../src/operator-key.ts";
import { derivedProviderResourceIncarnationName } from "../src/provider-worker-endpoint-origin.ts";
import { currentTakoformCandidates } from "../src/takoform/current-candidates.ts";
import { InMemoryTakoformResourceDriver } from "../src/takoform/memory-driver.ts";
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
const MUTATION_RESPONSE_TIMEOUT_MS = 20_000;
const OPERATION_RECOVERY_BUDGET_MS = 30_000;
const OPERATION_ID_PATTERN = /^op_[A-Za-z0-9][A-Za-z0-9._-]{0,124}$/u;
const KEY = "host-restart/shared-object.txt";
const FOREIGN_KEY = "host-restart/foreign-sentinel.txt";
const LOCAL_SECRET = "bucket-object-after-host-restart";
const FOREIGN_SECRET = "must-stay-in-the-other-bucket";
const BUCKETS = [
  ["ObjectBucket", "host-restart-media"],
  ["ObjectBucket", "host-restart-other"],
] as const;
const MAX_API_ERROR_BYTES = 4_096;
const MAX_API_ERROR_READ_MS = 1_000;
type JourneyFailureRecord = { primary?: unknown; cleanup?: unknown };
const privateJourneyFailureRecords = new WeakMap<object, JourneyFailureRecord>();

function journeyFailureRecord(error: unknown): JourneyFailureRecord | undefined {
  return typeof error === "object" && error !== null
    ? privateJourneyFailureRecords.get(error)
    : undefined;
}

function journeyFailureChain(error: unknown): JourneyFailureRecord[] {
  const chain: JourneyFailureRecord[] = [];
  const seen = new Set<object>();
  let current = error;
  while (typeof current === "object" && current !== null && !seen.has(current)) {
    seen.add(current);
    const record = privateJourneyFailureRecords.get(current);
    if (!record) break;
    chain.push(record);
    current = record.primary;
  }
  return chain;
}

function safeJourneyCause(error: unknown, depth = 0): Error {
  if (depth >= 8) return new Error("selfhost_object_bucket_cause_chain_truncated");
  const label =
    error instanceof JourneyApiFailure
      ? `selfhost_object_bucket_api_${error.method.toLowerCase()}_${error.status ?? "none"}_${error.apiCode ?? error.kind}`
      : `selfhost_object_bucket_primary_${safeJourneyErrorClass(error)}`;
  const cause = journeyFailureRecord(error)?.primary;
  return new Error(
    label,
    cause === undefined ? undefined : { cause: safeJourneyCause(cause, depth + 1) },
  );
}

function observeJourneyDiagnostic(
  message: string,
  observer: (message: string) => void = (line) => console.info(line),
): void {
  try {
    observer(message);
  } catch {
    // Diagnostics must never change the operation or cleanup outcome.
  }
}

function elapsedMilliseconds(startedAt: number): number {
  return Math.max(0, Math.round(performance.now() - startedAt));
}

async function runObservedOperation<T>(
  phase: JourneyPhase,
  operation: Exclude<JourneyDiagnosticOperation, "request">,
  run: () => Promise<T> | T,
  observer?: (message: string) => void,
): Promise<T> {
  observeJourneyDiagnostic(
    `[selfhost-object-bucket-host-restart] phase=${phase} operation=${operation} outcome=start`,
    observer,
  );
  try {
    const result = await run();
    observeJourneyDiagnostic(
      `[selfhost-object-bucket-host-restart] phase=${phase} operation=${operation} outcome=ok`,
      observer,
    );
    return result;
  } catch (error) {
    observeJourneyDiagnostic(
      `[selfhost-object-bucket-host-restart] phase=${phase} operation=${operation} outcome=failed`,
      observer,
    );
    throw error;
  }
}

function attemptOwnedCleanup(cleanup: () => void): unknown | undefined {
  try {
    cleanup();
    return undefined;
  } catch (error) {
    return error;
  }
}

function createSafeJourneyFailure(
  phase: JourneyPhase,
  operation: JourneyDiagnosticOperation,
  error: unknown,
): Error {
  const detail =
    error instanceof JourneyApiFailure
      ? `${error.method.toLowerCase()}_${error.status ?? "none"}_${error.apiCode ?? error.kind}`
      : safeJourneyErrorClass(error);
  const failure = new Error(
    `selfhost_object_bucket_journey_failed_phase_${phase}_operation_${operation}_${detail}`,
    { cause: safeJourneyCause(error) },
  );
  privateJourneyFailureRecords.set(failure, { primary: error });
  return failure;
}

function createSafeCleanupFailure(
  labels: readonly string[],
  primaryFailure: unknown,
  cleanupFailure: unknown,
): Error {
  const safeCauses: Error[] = [];
  if (primaryFailure !== undefined) safeCauses.push(safeJourneyCause(primaryFailure));
  if (cleanupFailure !== undefined) safeCauses.push(safeJourneyCause(cleanupFailure));
  const cause =
    safeCauses.length > 1
      ? new AggregateError(safeCauses, "selfhost_object_bucket_primary_and_cleanup_failures")
      : safeCauses[0];
  const failure = new Error(`selfhost_object_bucket_cleanup_unconfirmed_${labels.join("_")}`, {
    ...(cause === undefined ? {} : { cause }),
  });
  const primary = journeyFailureChain(primaryFailure)[0]?.primary ?? primaryFailure;
  privateJourneyFailureRecords.set(failure, {
    ...(primary === undefined ? {} : { primary }),
    ...(cleanupFailure === undefined ? {} : { cleanup: cleanupFailure }),
  });
  return failure;
}

test("the current public ObjectBucket Resource omits undeclared provider outputs", async () => {
  const form = currentTakoformCandidates().forms.find(
    (candidate) => candidate.identity.formRef.kind === "ObjectBucket",
  );
  if (!form) throw new Error("selfhost_object_bucket_current_form_missing");

  const inMemory = new InMemoryTakoformResourceDriver();
  const driver = new (class extends InMemoryTakoformResourceDriver {
    override async apply(input: Parameters<typeof inMemory.apply>[0]) {
      return {
        ...(await inMemory.apply(input)),
        outputs: { bucketName: "provider-private-test-name" },
      };
    }
  })();
  const host = createStaticTestTakoformHost({
    sql: createEphemeralSql(),
    objects: createMemoryObjectStore(),
    forms: [form],
    driver,
    authenticate: async (request) =>
      request.headers.get("authorization") === "Bearer current-object-bucket-test"
        ? {
            tenantId: "tenant_object_bucket_test",
            principalId: "principal_object_bucket_test",
          }
        : null,
  });
  const formRef = form.identity.formRef;
  const desired = {
    apiVersion: formRef.apiVersion,
    kind: formRef.kind,
    form: { formRef },
    metadata: { space: "default", name: "projection" },
    spec: {},
  };
  const authorization = { authorization: "Bearer current-object-bucket-test" };
  const hostFetch: HostApiFetch = async (request) =>
    (await host.handle(request)) ?? new Response(null, { status: 404 });
  const prepared = await api<Json>(
    "POST",
    `${LANE}/resources/prepare`,
    200,
    desired,
    authorization,
    "prepare",
    hostFetch,
  );

  const query = new URLSearchParams({
    space: desired.metadata.space,
    definitionVersion: formRef.definitionVersion,
    schemaDigest: formRef.schemaDigest,
  });
  const resource = await api<Json>(
    "PUT",
    `${LANE}/resources/${formRef.apiVersion}/${formRef.kind}/${desired.metadata.name}?${query}`,
    201,
    { ...desired, review: prepared.review },
    {
      ...authorization,
      "idempotency-key": "current-object-bucket-projection",
      "if-none-match": "*",
    },
    "put",
    hostFetch,
  );
  expect(form.identity.formRef).toMatchObject({
    apiVersion: "edge.forms.takoform.com",
    definitionVersion: "0.1.0",
    kind: "ObjectBucket",
    schemaDigest: "sha256:154e2dcf100b1278f3badb7f7f2f25bba8c6bcf387c75fb6b9abc5ede1cbd557",
  });
  expect(form.outputSchema).toBeUndefined();
  expect((objectAt(resource, "status").outputs as Json | undefined)?.bucketName).toBeUndefined();

  let classifiedFailure: unknown;
  try {
    await api<Json>(
      "POST",
      `${LANE}/resources/prepare`,
      200,
      {},
      authorization,
      "prepare",
      hostFetch,
    );
  } catch (error) {
    classifiedFailure = error;
  }
  expect(classifiedFailure).toBeInstanceOf(JourneyApiFailure);
  expect(classifiedFailure).toMatchObject({
    operation: "prepare",
    method: "POST",
    status: 400,
    expectedStatus: 200,
  });
  expect((classifiedFailure as JourneyApiFailure).apiCode).toMatch(/^[a-z][a-z0-9_]{0,63}$/u);
});

test("journey diagnostics and cleanup preserve primary failures", async () => {
  const throwingObserver = () => {
    throw new Error("observer_failure_must_not_escape");
  };
  let operationRan = false;
  await expect(
    runObservedOperation(
      "object_bucket_creation",
      "prepare",
      () => {
        operationRan = true;
        return "completed";
      },
      throwingObserver,
    ),
  ).resolves.toBe("completed");
  expect(operationRan).toBe(true);

  const primaryFailure = new Error("primary_operation_failure");
  await expect(
    runObservedOperation(
      "object_bucket_creation",
      "put",
      () => {
        throw primaryFailure;
      },
      throwingObserver,
    ),
  ).rejects.toBe(primaryFailure);

  const sanitizedFailure = createSafeJourneyFailure(
    "object_bucket_creation",
    "put",
    primaryFailure,
  );
  const cleanupFailure = new Error("fixture_cleanup_failure");
  expect(
    attemptOwnedCleanup(() => {
      throw cleanupFailure;
    }),
  ).toBe(cleanupFailure);
  const combinedFailure = createSafeCleanupFailure(["fixture"], sanitizedFailure, cleanupFailure);
  expect(journeyFailureRecord(combinedFailure)).toEqual({
    primary: primaryFailure,
    cleanup: cleanupFailure,
  });
  expect(journeyFailureChain(combinedFailure)).toEqual([
    { primary: primaryFailure, cleanup: cleanupFailure },
  ]);
  expect(combinedFailure.cause).toBeInstanceOf(AggregateError);
  expect(
    (combinedFailure.cause as AggregateError).errors.map((cause) => (cause as Error).message),
  ).toEqual([
    "selfhost_object_bucket_primary_operation",
    "selfhost_object_bucket_primary_operation",
  ]);
  expect(combinedFailure.message).not.toContain(primaryFailure.message);
  expect(combinedFailure.message).not.toContain(cleanupFailure.message);
});

test("journey API error classification bounds stalled response reads", async () => {
  const response = new Response(
    new ReadableStream<Uint8Array>({
      pull: () => new Promise<void>(() => undefined),
    }),
    { status: 400 },
  );
  await expect(boundedApiErrorCode(response)).resolves.toBe("unknown");

  let canceled = false;
  let chunks = 0;
  const slowDrip = new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        if (chunks >= 2) return new Promise<void>(() => undefined);
        return new Promise<void>((resolve) => {
          setTimeout(() => {
            if (!canceled) {
              chunks += 1;
              controller.enqueue(new Uint8Array([0x20]));
            }
            resolve();
          }, 400);
        });
      },
      cancel() {
        canceled = true;
      },
    }),
    { status: 400 },
  );
  const startedAt = performance.now();
  await expect(boundedApiErrorCode(slowDrip)).resolves.toBe("unknown");
  expect(performance.now() - startedAt).toBeLessThan(MAX_API_ERROR_READ_MS + 500);
  expect(canceled).toBe(true);
});

type Json = Record<string, unknown>;
type Host = ReturnType<typeof Bun.spawn>;
type JourneyDiagnosticOperation = "prepare" | "put" | "output" | "private_readback" | "request";
type JourneyHttpMethod = "GET" | "POST" | "PUT" | "DELETE";
type HostApiFetch = (request: Request) => Promise<Response>;
type JourneyPhase =
  | "core_verifier_startup"
  | "initial_host_management"
  | "form_admission"
  | "admitted_host_restart"
  | "form_discovery"
  | "object_bucket_creation"
  | "worker_artifact_upload"
  | "worker_resource_creation"
  | "initial_object_data"
  | "host_process_restart"
  | "post_restart_object_read"
  | "object_update_delete"
  | "resource_deletion";

class JourneyApiFailure extends Error {
  constructor(
    readonly operation: JourneyDiagnosticOperation,
    readonly method: JourneyHttpMethod,
    readonly kind: "http_status" | "transport" | "response_json",
    readonly status?: number,
    readonly expectedStatus?: number,
    readonly apiCode?: string,
    cause?: unknown,
  ) {
    super("selfhost_object_bucket_api_failure");
    if (cause !== undefined) privateJourneyFailureRecords.set(this, { primary: cause });
    this.name = "JourneyApiFailure";
  }
}

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
    observeJourneyDiagnostic(
      "[selfhost-object-bucket-host-restart] phase=isolation_preflight outcome=ok",
    );

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
    let cleanupCause: unknown;
    let caughtFailure = false;
    let testFailure: unknown;
    let currentPhase: JourneyPhase = "core_verifier_startup";
    let phaseStarted = false;
    let failedOperation: JourneyDiagnosticOperation | undefined;
    const phase = (next: JourneyPhase): void => {
      if (phaseStarted) {
        observeJourneyDiagnostic(
          `[selfhost-object-bucket-host-restart] phase=${currentPhase} outcome=ok`,
        );
      }
      currentPhase = next;
      phaseStarted = true;
      observeJourneyDiagnostic(`[selfhost-object-bucket-host-restart] phase=${next} outcome=start`);
    };
    const operationStep = async <T>(
      operation: Exclude<JourneyDiagnosticOperation, "request">,
      run: () => Promise<T> | T,
    ): Promise<T> => {
      failedOperation = undefined;
      const phaseAtStart = currentPhase;
      try {
        return await runObservedOperation(phaseAtStart, operation, run);
      } catch (error) {
        failedOperation = operation;
        throw error;
      }
    };
    try {
      phase("core_verifier_startup");
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

      phase("initial_host_management");
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
      phase("form_admission");
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
      phase("admitted_host_restart");
      await assertIsolatedSelfhostNativeEnvironment({
        fixedPorts: [API_PORT, 443],
        ownedChild: verifier,
      });
      host = startHost(hostEnvironment());
      await assertIsolatedSelfhostNativeEnvironment({ fixedPorts: [], ownedChild: host });
      await waitForHost(host);
      const firstHostPid = host.pid;

      phase("form_discovery");
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
        const prepared = await operationStep("prepare", () =>
          api<Json>("POST", `${LANE}/resources/prepare`, 200, desired, auth, "prepare"),
        );
        const query = formQuery(formRef);
        return await operationStep("put", () =>
          applyWithOperationRecovery({
            path: `${LANE}/resources/${stringAt(formRef, "apiVersion")}/${kind}/${name}?${query}`,
            body: { ...desired, review: objectAt(prepared, "review") },
            headers: {
              ...auth,
              "idempotency-key": `create-${kind}-${name}`,
              "if-none-match": "*",
            },
            expected: { apiVersion: stringAt(formRef, "apiVersion"), kind, name, space: SPACE },
          }),
        );
      };

      phase("object_bucket_creation");
      const buckets = new Map<string, Json>();
      for (const [kind, name] of BUCKETS) buckets.set(name, await apply(kind, name, {}));
      const bucketPaths = new Map<string, string>();
      for (const [name, resource] of buckets) {
        const uid = stringAt(objectAt(resource, "metadata"), "uid");
        // This derived path is private fixture custody only; it is not a
        // public ObjectBucket output or part of Resource status.
        const bucketId = await derivedProviderResourceIncarnationName("tsb", {
          tenantRef: organizationId,
          space: SPACE,
          name,
          uid,
        });
        bucketPaths.set(name, join(dataRoot, "selfhost", "objects", bucketId));
      }

      const publishModuleArtifact = async (source: string, id: string): Promise<string> => {
        phase("worker_artifact_upload");
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
        phase("worker_resource_creation");
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
        const url = new URL(await operationStep("output", () => output(resource, "url")));
        if (url.protocol !== "https:" || url.port !== "") {
          throw new Error("selfhost_object_bucket_endpoint_not_canonical_https");
        }
        endpoints.set(app.worker, url.hostname);
      }
      const mediaHost = endpoints.get("object-bucket-media-worker");
      const otherHost = endpoints.get("object-bucket-other-worker");
      if (!mediaHost || !otherHost) throw new Error("selfhost_object_bucket_endpoint_missing");
      const certificate = join(tlsDirectory, "worker-cert.pem");

      phase("initial_object_data");
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
      await operationStep("private_readback", () => {
        expect(existsSync(mediaBucketPath)).toBe(true);
        expect(existsSync(otherBucketPath)).toBe(true);
      });

      phase("host_process_restart");
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
      const createdMediaBucket = buckets.get("host-restart-media");
      if (!createdMediaBucket) throw new Error("selfhost_object_bucket_resource_missing");
      expect(stringAt(objectAt(retainedBucket, "metadata"), "uid")).toBe(
        stringAt(objectAt(createdMediaBucket, "metadata"), "uid"),
      );
      phase("post_restart_object_read");
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
      phase("object_update_delete");
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
      await operationStep("private_readback", () => {
        expect(countRegularFiles(mediaBucketPath)).toBe(0);
      });

      phase("resource_deletion");
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
      await operationStep("private_readback", () => {
        expect(existsSync(mediaBucketPath)).toBe(false);
        expect(existsSync(otherBucketPath)).toBe(false);
      });
      expect(statSync(join(dataRoot, "selfhost", "objects")).isDirectory()).toBe(true);
      observeJourneyDiagnostic(
        `[selfhost-object-bucket-host-restart] phase=${currentPhase} outcome=ok`,
      );
    } catch (error) {
      caughtFailure = true;
      const operation =
        error instanceof JourneyApiFailure ? error.operation : (failedOperation ?? "request");
      const safeApiDetail =
        error instanceof JourneyApiFailure
          ? ` method=${error.method.toLowerCase()} status=${error.status ?? "none"} expected=${error.expectedStatus ?? "none"} api_code=${error.apiCode ?? error.kind}`
          : ` class=${safeJourneyErrorClass(error)}`;
      observeJourneyDiagnostic(
        `[selfhost-object-bucket-host-restart] phase=${currentPhase} operation=${operation} outcome=failed${safeApiDetail}`,
      );
      testFailure = createSafeJourneyFailure(currentPhase, operation, error);
    } finally {
      if (admission) {
        try {
          await stopChild(admission, "selfhost_object_bucket_admission");
          admission = undefined;
        } catch (error) {
          cleanupFailures.push("admission");
          cleanupCause ??= error;
        }
      }
      if (host) {
        try {
          await stopHost(host);
          host = undefined;
        } catch (error) {
          cleanupFailures.push("host");
          cleanupCause ??= error;
        }
      }
      if (verifier) {
        try {
          await stopChild(verifier, "selfhost_object_bucket_core");
          verifier = undefined;
        } catch (error) {
          cleanupFailures.push("core");
          cleanupCause ??= error;
        }
      }
      if (cleanupFailures.length === 0) {
        cleanupCause = attemptOwnedCleanup(() => rmSync(fixture, { recursive: true, force: true }));
        if (cleanupCause !== undefined) cleanupFailures.push("fixture");
      }
    }
    if (cleanupFailures.length > 0) {
      throw createSafeCleanupFailure(
        cleanupFailures,
        caughtFailure ? testFailure : undefined,
        cleanupCause,
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
  method: JourneyHttpMethod,
  path: string,
  expectedStatus: number,
  body?: unknown,
  headers: Record<string, string> = {},
  operation: JourneyDiagnosticOperation = "request",
  fetchRequest: HostApiFetch = (request) => fetch(request),
  timeoutMilliseconds = 10_000,
): Promise<T> {
  const response = await apiResponse(
    method,
    path,
    expectedStatus,
    body,
    headers,
    operation,
    fetchRequest,
    timeoutMilliseconds,
  );
  if (response.status !== expectedStatus) {
    const code = await boundedApiErrorCode(response);
    throw new JourneyApiFailure(
      operation,
      method,
      "http_status",
      response.status,
      expectedStatus,
      code,
    );
  }
  if (response.status === 204) return undefined as T;
  try {
    return (await response.json()) as T;
  } catch (cause) {
    throw new JourneyApiFailure(
      operation,
      method,
      "response_json",
      response.status,
      expectedStatus,
      undefined,
      cause,
    );
  }
}

async function apiResponse(
  method: JourneyHttpMethod,
  path: string,
  expectedStatus: number,
  body: unknown,
  headers: Record<string, string>,
  operation: JourneyDiagnosticOperation,
  fetchRequest: HostApiFetch,
  timeoutMilliseconds: number,
): Promise<Response> {
  try {
    return await fetchRequest(
      new Request(`${HOST_ORIGIN}${path}`, {
        method,
        headers: {
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          ...headers,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(timeoutMilliseconds),
      }),
    );
  } catch (cause) {
    throw new JourneyApiFailure(
      operation,
      method,
      "transport",
      undefined,
      expectedStatus,
      undefined,
      cause,
    );
  }
}

async function applyWithOperationRecovery(input: {
  readonly path: string;
  readonly body: Json;
  readonly headers: Record<string, string>;
  readonly expected: {
    readonly apiVersion: string;
    readonly kind: string;
    readonly name: string;
    readonly space: string;
  };
}): Promise<Json> {
  const startedAt = performance.now();
  const submission = await apiResponse(
    "PUT",
    input.path,
    201,
    input.body,
    input.headers,
    "put",
    (request) => fetch(request),
    MUTATION_RESPONSE_TIMEOUT_MS,
  );
  if (submission.status === 201) {
    const resource = (await submission.json()) as Json;
    assertMutationResourceIdentity(resource, input.expected);
    observeJourneyDiagnostic(
      `[selfhost-object-bucket-host-restart] operation=put outcome=resource status=201 elapsed_ms=${elapsedMilliseconds(startedAt)}`,
    );
    return resource;
  }
  if (submission.status !== 202) {
    const code = await boundedApiErrorCode(submission);
    throw new JourneyApiFailure("put", "PUT", "http_status", submission.status, 201, code);
  }

  const accepted = (await submission.json()) as Json;
  const acceptedOperation = objectAt(accepted, "operation");
  const operationId = stringAt(acceptedOperation, "id");
  if (
    acceptedOperation.apiVersion !== "operations.takoform.com/v1alpha1" ||
    acceptedOperation.kind !== "Operation" ||
    acceptedOperation.done !== false ||
    !OPERATION_ID_PATTERN.test(operationId)
  ) {
    throw new Error("selfhost_object_bucket_operation_acceptance_invalid");
  }
  observeJourneyDiagnostic(
    `[selfhost-object-bucket-host-restart] operation=put outcome=accepted status=202 elapsed_ms=${elapsedMilliseconds(startedAt)}`,
  );

  const recoveryDeadline = performance.now() + OPERATION_RECOVERY_BUDGET_MS;
  const operationPath = `${LANE}/operations/${encodeURIComponent(operationId)}`;
  let delay = retryAfterDelayMilliseconds(submission.headers, 0);
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const remaining = recoveryDeadline - performance.now();
    if (remaining <= delay + 1) {
      throw new Error("selfhost_object_bucket_operation_wait_deadline_exceeded");
    }
    if (delay > 0) await Bun.sleep(delay);
    const timeoutMilliseconds = Math.max(
      1,
      Math.min(MUTATION_RESPONSE_TIMEOUT_MS, Math.floor(recoveryDeadline - performance.now())),
    );
    const pollResponse = await apiResponse(
      "GET",
      operationPath,
      200,
      undefined,
      input.headers,
      "request",
      (request) => fetch(request),
      timeoutMilliseconds,
    );
    if (pollResponse.status !== 200) {
      const code = await boundedApiErrorCode(pollResponse);
      throw new JourneyApiFailure("request", "GET", "http_status", pollResponse.status, 200, code);
    }
    const poll = (await pollResponse.json()) as Json;
    if (
      poll.id !== operationId ||
      poll.apiVersion !== "operations.takoform.com/v1alpha1" ||
      poll.kind !== "Operation"
    ) {
      throw new Error("selfhost_object_bucket_operation_response_invalid");
    }
    if (poll.done === true) {
      if (poll.error !== undefined) {
        const error =
          typeof poll.error === "object" && poll.error !== null ? (poll.error as Json) : undefined;
        const code =
          typeof error?.code === "string" && /^[a-z][a-z0-9_]{0,63}$/u.test(error.code)
            ? error.code
            : "unknown";
        throw new Error(`selfhost_object_bucket_operation_failed_${code}`);
      }
      const result = objectAt(poll, "result");
      const resource = objectAt(result, "resource");
      assertMutationResourceIdentity(resource, input.expected);
      observeJourneyDiagnostic(
        `[selfhost-object-bucket-host-restart] operation=operation_poll outcome=settled status=200 elapsed_ms=${elapsedMilliseconds(startedAt)}`,
      );
      return resource;
    }
    if (poll.done !== false) throw new Error("selfhost_object_bucket_operation_state_invalid");
    observeJourneyDiagnostic(
      `[selfhost-object-bucket-host-restart] operation=operation_poll outcome=pending status=200 elapsed_ms=${elapsedMilliseconds(startedAt)}`,
    );
    delay = retryAfterDelayMilliseconds(pollResponse.headers, attempt + 1);
  }
  throw new Error("selfhost_object_bucket_operation_poll_limit_exceeded");
}

function assertMutationResourceIdentity(
  resource: Json,
  expected: {
    readonly apiVersion: string;
    readonly kind: string;
    readonly name: string;
    readonly space: string;
  },
): void {
  const metadata = objectAt(resource, "metadata");
  if (
    resource.apiVersion !== expected.apiVersion ||
    resource.kind !== expected.kind ||
    metadata.name !== expected.name ||
    metadata.space !== expected.space ||
    typeof metadata.uid !== "string" ||
    metadata.uid.length === 0
  ) {
    throw new Error("selfhost_object_bucket_mutation_identity_invalid");
  }
}

function retryAfterDelayMilliseconds(headers: Headers, attempt: number): number {
  const retryAfter = headers.get("retry-after");
  if (retryAfter === null) {
    return Math.floor(Math.random() * Math.min(1_000, 100 * 2 ** Math.min(attempt, 3)));
  }
  if (!/^(0|[1-9][0-9]*)$/u.test(retryAfter)) {
    throw new Error("selfhost_object_bucket_retry_after_invalid");
  }
  const milliseconds = Number(retryAfter) * 1_000;
  if (!Number.isSafeInteger(milliseconds)) {
    throw new Error("selfhost_object_bucket_retry_after_invalid");
  }
  return milliseconds;
}

async function boundedApiErrorCode(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "unknown";
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  const deadline = performance.now() + MAX_API_ERROR_READ_MS;
  try {
    while (byteLength <= MAX_API_ERROR_BYTES) {
      const remainingMs = deadline - performance.now();
      if (remainingMs <= 0) {
        void reader.cancel().catch(() => undefined);
        return "unknown";
      }
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
      const timedOut = new Promise<null>((resolve) => {
        timeoutHandle = setTimeout(() => resolve(null), remainingMs);
      });
      let next: Awaited<ReturnType<typeof reader.read>> | null;
      try {
        next = await Promise.race([reader.read(), timedOut]);
      } finally {
        if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
      }
      if (next === null) {
        void reader.cancel().catch(() => undefined);
        return "unknown";
      }
      const { done, value } = next;
      if (done) break;
      const remaining = MAX_API_ERROR_BYTES + 1 - byteLength;
      const bounded = value.subarray(0, remaining);
      chunks.push(bounded);
      byteLength += bounded.byteLength;
      if (byteLength > MAX_API_ERROR_BYTES) {
        void reader.cancel().catch(() => undefined);
        return "unknown";
      }
    }
  } catch {
    return "unknown";
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // A timed-out read may still be settling while cancellation propagates.
    }
  }

  try {
    const bytes = new Uint8Array(byteLength);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const payload = JSON.parse(new TextDecoder().decode(bytes)) as Json;
    const envelope = payload.error;
    if (typeof envelope !== "object" || envelope === null || Array.isArray(envelope))
      return "unknown";
    const candidate = (envelope as Json).code;
    return typeof candidate === "string" && /^[a-z][a-z0-9_]{0,63}$/u.test(candidate)
      ? candidate
      : "unknown";
  } catch {
    return "unknown";
  }
}

function safeJourneyErrorClass(error: unknown): "timeout" | "type" | "syntax" | "operation" {
  if (error instanceof DOMException && error.name === "TimeoutError") return "timeout";
  if (!(error instanceof Error)) return "operation";
  if (error.name === "TimeoutError" || error.name === "AbortError") return "timeout";
  if (error.name === "TypeError") return "type";
  if (error.name === "SyntaxError") return "syntax";
  return "operation";
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
