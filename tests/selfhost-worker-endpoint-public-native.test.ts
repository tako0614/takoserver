import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
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

const NATIVE_OPT_IN = nativeEvidenceBinary("worker-endpoint-public-create-diagnostic");
const WORKERD = nativeEvidenceBinary(
  "worker-endpoint-public-create-diagnostic",
  "TAKOSERVER_WORKERD_BINARY",
);
const HOST_ORIGIN = "http://127.0.0.1:8787";
const API_PORT = 8787;
const CORE_PORT = 8080;
const CORE_ORIGIN = `http://127.0.0.1:${CORE_PORT}`;
const WORKER_SUFFIX = "apps.selfhost.test";
const SPACE = "default";
const LANE = "/apis/forms.takoform.com/v1";
const PREPARE_TIMEOUT_MS = 10_000;
const MUTATION_RESPONSE_TIMEOUT_MS = 20_000;
const SETUP_OPERATION_BUDGET_MS = 30_000;
const ENDPOINT_OPERATION_BUDGET_MS = 90_000;
const DEFAULT_OPERATION_RETRY_AFTER_MS = 1_000;
const OPERATION_ID = /^op_[A-Za-z0-9][A-Za-z0-9._-]{0,124}$/u;
const MODULE_SOURCE = `export default { async fetch() { return new Response("ready") } };\n`;
const API_KEY_SCOPES = ["resources:read", "resources:write"];

type Json = Record<string, unknown>;
type Host = ReturnType<typeof Bun.spawn>;
type Child = ReturnType<typeof Bun.spawn>;
type SafeStage =
  | "isolation_preflight"
  | "core_verifier_startup"
  | "initial_host_management"
  | "form_admission"
  | "admitted_host_startup"
  | "form_discovery"
  | "module_artifact_upload"
  | "module_worker_create"
  | "worker_bundle_create"
  | "worker_version_create"
  | "worker_deployment_create"
  | "worker_endpoint_prepare"
  | "worker_endpoint_create"
  | "worker_endpoint_operation_get"
  | "worker_endpoint_resource_readback"
  | "fixture_cleanup";

class DiagnosticFailure extends Error {
  constructor(
    readonly stage: SafeStage,
    readonly category: string,
    readonly status?: number,
    readonly requestElapsedMs?: number,
  ) {
    super(`worker_endpoint_public_create_${stage}_${category}${status ? `_http_${status}` : ""}`);
  }
}

function mutationFetchFailure(
  stage: SafeStage,
  signal: AbortSignal,
  startedAt: number,
  endedAt: number,
): DiagnosticFailure {
  return new DiagnosticFailure(
    stage,
    signal.aborted ? "mutation_deadline_exceeded" : "mutation_transport_error",
    undefined,
    Math.max(0, Math.round(endedAt - startedAt)),
  );
}

function observe(stage: SafeStage, outcome: "start" | "ok" | "failed", fields: Json = {}): void {
  const safeFields = Object.entries(fields)
    .filter(
      ([key, value]) =>
        [
          "elapsed_ms",
          "request_elapsed_ms",
          "status",
          "poll",
          "operation_id_hash",
          "resource_uid_hash",
          "http_code",
        ].includes(key) &&
        (typeof value === "number" || typeof value === "string"),
    )
    .map(([key, value]) => `${key}=${value}`)
    .join(" ");
  console.info(
    `[worker-endpoint-public-create] stage=${stage} outcome=${outcome}${safeFields ? ` ${safeFields}` : ""}`,
  );
}

function digestIdentity(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function writeCustodyPointer(root: string): string {
  const home = process.env.HOME;
  if (!home) throw new DiagnosticFailure("isolation_preflight", "private_home_required");
  let homeMode: number;
  try {
    const homeStat = statSync(home);
    if (!homeStat.isDirectory()) throw new Error("not_directory");
    homeMode = homeStat.mode & 0o777;
  } catch {
    throw new DiagnosticFailure("isolation_preflight", "private_home_unavailable");
  }
  if ((homeMode & 0o077) !== 0) {
    throw new DiagnosticFailure("isolation_preflight", "private_home_permissions_invalid");
  }
  const pointer = join(home, `worker-endpoint-public-custody-${process.pid}.json`);
  try {
    writeFileSync(pointer, `${JSON.stringify({ version: 1, root })}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
  } catch {
    throw new DiagnosticFailure("isolation_preflight", "custody_pointer_write_failed");
  }
  console.info(`[worker-endpoint-public-create] custody_pointer=${pointer}`);
  return pointer;
}

function objectAt(value: Json, key: string, stage: SafeStage): Json {
  const result = value[key];
  if (result === null || typeof result !== "object" || Array.isArray(result)) {
    throw new DiagnosticFailure(stage, "response_shape_invalid");
  }
  return result as Json;
}

function stringAt(value: Json, key: string, stage: SafeStage): string {
  const result = value[key];
  if (typeof result !== "string" || result.length === 0) {
    throw new DiagnosticFailure(stage, "response_shape_invalid");
  }
  return result;
}

async function jsonResponse(response: Response, stage: SafeStage): Promise<Json> {
  try {
    const body: unknown = await response.json();
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      throw new DiagnosticFailure(stage, "response_shape_invalid", response.status);
    }
    return body as Json;
  } catch (error) {
    if (error instanceof DiagnosticFailure) throw error;
    throw new DiagnosticFailure(stage, "response_json_invalid", response.status);
  }
}

async function hostRequest(
  method: string,
  path: string,
  body: unknown,
  headers: Record<string, string>,
  timeoutMilliseconds: number,
  stage: SafeStage,
): Promise<Response> {
  try {
    return await fetch(`${HOST_ORIGIN}${path}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(timeoutMilliseconds),
    });
  } catch {
    throw new DiagnosticFailure(stage, "transport_unknown");
  }
}

async function expectJson(
  method: string,
  path: string,
  body: unknown,
  headers: Record<string, string>,
  expectedStatus: number,
  stage: SafeStage,
  timeoutMilliseconds = PREPARE_TIMEOUT_MS,
): Promise<Json> {
  const response = await hostRequest(method, path, body, headers, timeoutMilliseconds, stage);
  if (response.status !== expectedStatus) {
    throw new DiagnosticFailure(stage, "unexpected_status", response.status);
  }
  return await jsonResponse(response, stage);
}

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

function startHost(environment: Record<string, string>): Host {
  const child = Bun.spawn([process.execPath, "--no-env-file", "src/entry-bun.ts"], {
    cwd: process.cwd(),
    env: environment,
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  return child;
}

async function waitForHost(host: Host, stage: SafeStage): Promise<void> {
  const deadline = performance.now() + 15_000;
  while (performance.now() < deadline) {
    if (host.exitCode !== null || host.signalCode !== null) {
      throw new DiagnosticFailure(stage, "host_exited");
    }
    try {
      const response = await fetch(`${HOST_ORIGIN}/.well-known/takoform/v1`, {
        signal: AbortSignal.timeout(500),
      });
      await response.arrayBuffer();
      if (response.ok) return;
    } catch {
      // The public listener, not child creation, is the startup signal.
    }
    await Bun.sleep(50);
  }
  throw new DiagnosticFailure(stage, "listener_timeout");
}

async function stopChild(child: Child, stage: SafeStage): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  const result = await Promise.race([child.exited, Bun.sleep(8_000).then(() => null)]);
  if (result !== null) return;
  child.kill("SIGKILL");
  const killed = await Promise.race([child.exited, Bun.sleep(2_000).then(() => null)]);
  if (killed === null) throw new DiagnosticFailure(stage, "owned_child_exit_unknown");
}

async function waitForCore(verifier: Child, artifactDigest: string): Promise<void> {
  const deadline = performance.now() + 15_000;
  while (performance.now() < deadline) {
    if (verifier.exitCode !== null || verifier.signalCode !== null) {
      throw new DiagnosticFailure("core_verifier_startup", "verifier_exited");
    }
    try {
      const response = await fetch(`${CORE_ORIGIN}/v1/identity`, {
        signal: AbortSignal.timeout(500),
      });
      if (response.ok) {
        const identity = await jsonResponse(response, "core_verifier_startup");
        if (
          identity.protocol !== "takoserver.takoform-core-verifier@v1" ||
          identity.coreVersion !== "v1.1.0" ||
          identity.coreCommit !== "e0e48b864de2a127a255cb0574d37bbb0f1cac29" ||
          identity.artifactDigest !== artifactDigest
        ) {
          throw new DiagnosticFailure("core_verifier_startup", "identity_mismatch");
        }
        return;
      }
    } catch (error) {
      if (error instanceof DiagnosticFailure) throw error;
    }
    await Bun.sleep(50);
  }
  throw new DiagnosticFailure("core_verifier_startup", "identity_timeout");
}

async function createTls(directory: string): Promise<void> {
  const key = join(directory, "worker-key.pem");
  const certificate = join(directory, "worker-cert.pem");
  const generated = Bun.spawnSync(
    [
      "openssl",
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      key,
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
  if (!generated.success)
    throw new DiagnosticFailure("core_verifier_startup", "tls_generation_failed");
  chmodSync(key, 0o600);
  chmodSync(certificate, 0o600);
}

async function verifyAndAdmit(
  organizationId: string,
  dataRoot: string,
  environment: Record<string, string>,
  track: (child: Child | undefined) => void,
): Promise<void> {
  const closure = await loadPublisherSetClosure();
  const request = await realCoreVerificationRequest(closure);
  let response: Response;
  try {
    response = await fetch(`${CORE_ORIGIN}/v1/verify-set`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new DiagnosticFailure("form_admission", "core_verification_transport_unknown");
  }
  if (response.status !== 200) {
    throw new DiagnosticFailure("form_admission", "core_verification_refused", response.status);
  }
  const accepted = await jsonResponse(response, "form_admission");
  const identity = objectAt(accepted, "identity", "form_admission");
  if (
    identity.protocol !== "takoserver.takoform-core-verifier@v1" ||
    identity.coreVersion !== "v1.1.0" ||
    identity.coreCommit !== "e0e48b864de2a127a255cb0574d37bbb0f1cac29" ||
    !Array.isArray(accepted.packages) ||
    accepted.packages.length !== closure.identity.packageCount
  ) {
    throw new DiagnosticFailure("form_admission", "core_verification_identity_mismatch");
  }

  const cli = Bun.spawn(
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
      HOST_ORIGIN,
      "--core-verifier",
      CORE_ORIGIN,
    ],
    {
      cwd: process.cwd(),
      env: environment,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    },
  );
  track(cli);
  const exitCode = await Promise.race([cli.exited, Bun.sleep(120_000).then(() => null)]);
  if (exitCode === null) {
    await stopChild(cli, "form_admission");
    track(undefined);
    throw new DiagnosticFailure("form_admission", "admission_cli_timeout");
  }
  track(undefined);
  if (exitCode !== 0) throw new DiagnosticFailure("form_admission", "admission_cli_failed");
  const stdout = await new Response(cli.stdout).text();
  if (!/^apply: converged \([1-9]\d* receipt\(s\), released-core\)$/mu.test(stdout.trim())) {
    throw new DiagnosticFailure("form_admission", "admission_cli_receipt_missing");
  }
}

function formQuery(form: Json): string {
  return new URLSearchParams({
    space: SPACE,
    definitionVersion: stringAt(form, "definitionVersion", "form_discovery"),
    schemaDigest: stringAt(form, "schemaDigest", "form_discovery"),
  }).toString();
}

function assertResourceIdentity(
  resource: Json,
  apiVersion: string,
  kind: string,
  name: string,
  stage: SafeStage,
): string {
  const metadata = objectAt(resource, "metadata", stage);
  const uid = stringAt(metadata, "uid", stage);
  if (
    resource.kind !== kind ||
    metadata.name !== name ||
    metadata.space !== SPACE ||
    resource.apiVersion !== apiVersion
  ) {
    throw new DiagnosticFailure(stage, "resource_identity_mismatch");
  }
  return uid;
}

function reference(form: Json, kind: string, name: string): Json {
  return {
    apiVersion: stringAt(form, "apiVersion", "form_discovery"),
    kind,
    name,
  };
}

function expectedApiVersion(form: Json): string {
  return stringAt(form, "apiVersion", "form_discovery");
}

async function prepareResource(
  auth: Record<string, string>,
  form: Json,
  kind: string,
  name: string,
  spec: Json,
): Promise<{ desired: Json; review: Json; path: string }> {
  const apiVersion = expectedApiVersion(form);
  const stage = kind === "WorkerEndpoint" ? "worker_endpoint_prepare" : setupStage(kind);
  const startedAt = performance.now();
  observe(stage, "start");
  const desired = {
    apiVersion,
    kind,
    form: { formRef: form },
    metadata: { name, space: SPACE },
    spec,
  };
  const prepared = await expectJson(
    "POST",
    `${LANE}/resources/prepare`,
    desired,
    auth,
    200,
    stage,
    PREPARE_TIMEOUT_MS,
  );
  const review = objectAt(prepared, "review", stage);
  observe(stage, "ok", { elapsed_ms: Math.round(performance.now() - startedAt) });
  return {
    desired,
    review,
    path: `${LANE}/resources/${apiVersion}/${kind}/${name}?${formQuery(form)}`,
  };
}

function setupStage(kind: string): SafeStage {
  switch (kind) {
    case "ModuleWorker":
      return "module_worker_create";
    case "WorkerBundle":
      return "worker_bundle_create";
    case "WorkerVersion":
      return "worker_version_create";
    default:
      return "worker_deployment_create";
  }
}

async function createWithReceipt(input: {
  readonly auth: Record<string, string>;
  readonly form: Json;
  readonly kind: string;
  readonly name: string;
  readonly spec: Json;
  readonly stage: SafeStage;
  readonly operationBudgetMs: number;
  readonly idempotencyKey: string;
  readonly onMutationStart: () => void;
}): Promise<Json> {
  const prepared = await prepareResource(
    input.auth,
    input.form,
    input.kind,
    input.name,
    input.spec,
  );
  const apiVersion = expectedApiVersion(input.form);
  const startedAt = performance.now();
  input.onMutationStart();
  const requestStartedAt = performance.now();
  const requestDeadline = AbortSignal.timeout(MUTATION_RESPONSE_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(`${HOST_ORIGIN}${prepared.path}`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        ...input.auth,
        "idempotency-key": input.idempotencyKey,
        "if-none-match": "*",
      },
      body: JSON.stringify({ ...prepared.desired, review: prepared.review }),
      signal: requestDeadline,
    });
  } catch {
    throw mutationFetchFailure(input.stage, requestDeadline, requestStartedAt, performance.now());
  }
  if (response.status === 201) {
    const resource = await jsonResponse(response, input.stage);
    const uid = assertResourceIdentity(resource, apiVersion, input.kind, input.name, input.stage);
    observe(input.stage, "ok", {
      status: 201,
      elapsed_ms: Math.round(performance.now() - startedAt),
      resource_uid_hash: digestIdentity(uid),
    });
    return resource;
  }
  return await recoverAcceptedOperation({
    response,
    auth: input.auth,
    stage: input.stage,
    kind: input.kind,
    name: input.name,
    operationBudgetMs: input.operationBudgetMs,
    startedAt,
    apiVersion,
  });
}

async function recoverAcceptedOperation(input: {
  readonly response: Response;
  readonly auth: Record<string, string>;
  readonly stage: SafeStage;
  readonly kind: string;
  readonly name: string;
  readonly operationBudgetMs: number;
  readonly startedAt: number;
  readonly apiVersion: string;
}): Promise<Json> {
  if (input.response.status !== 202) {
    throw new DiagnosticFailure(input.stage, "mutation_unexpected_status", input.response.status);
  }
  const accepted = await jsonResponse(input.response, input.stage);
  const operation = objectAt(accepted, "operation", input.stage);
  const operationId = stringAt(operation, "id", input.stage);
  if (
    operation.apiVersion !== "operations.takoform.com/v1alpha1" ||
    operation.kind !== "Operation" ||
    operation.done !== false ||
    !OPERATION_ID.test(operationId)
  ) {
    throw new DiagnosticFailure(input.stage, "operation_acceptance_invalid", 202);
  }
  const operationHash = digestIdentity(operationId);
  observe(input.stage, "ok", {
    status: 202,
    elapsed_ms: Math.round(performance.now() - input.startedAt),
    operation_id_hash: operationHash,
  });

  const deadline = performance.now() + input.operationBudgetMs;
  const maxPolls = Math.ceil(input.operationBudgetMs / DEFAULT_OPERATION_RETRY_AFTER_MS);
  let poll = 0;
  let delay = retryAfterDelay(input.response.headers, 0);
  while (performance.now() < deadline && poll < maxPolls) {
    const remaining = deadline - performance.now();
    if (remaining <= delay + 1) break;
    if (delay > 0) await Bun.sleep(delay);
    poll += 1;
    observe("worker_endpoint_operation_get", "start", {
      poll,
      operation_id_hash: operationHash,
    });
    let response: Response;
    try {
      response = await fetch(
        `${HOST_ORIGIN}${LANE}/operations/${encodeURIComponent(operationId)}`,
        {
          headers: input.auth,
          signal: AbortSignal.timeout(Math.max(1, Math.min(10_000, deadline - performance.now()))),
        },
      );
    } catch {
      observe("worker_endpoint_operation_get", "failed", {
        poll,
        operation_id_hash: operationHash,
      });
      throw new DiagnosticFailure("worker_endpoint_operation_get", "transport_unknown");
    }
    if (response.status !== 200) {
      observe("worker_endpoint_operation_get", "failed", {
        poll,
        status: response.status,
        operation_id_hash: operationHash,
      });
      throw new DiagnosticFailure(
        "worker_endpoint_operation_get",
        "unexpected_status",
        response.status,
      );
    }
    const state = await jsonResponse(response, "worker_endpoint_operation_get");
    if (
      state.id !== operationId ||
      state.apiVersion !== "operations.takoform.com/v1alpha1" ||
      state.kind !== "Operation"
    ) {
      throw new DiagnosticFailure("worker_endpoint_operation_get", "operation_identity_mismatch");
    }
    if (state.done === true) {
      if (state.error !== undefined) {
        const error = objectAt(state, "error", "worker_endpoint_operation_get");
        const code =
          typeof error.code === "string" && /^[a-z][a-z0-9_]{0,63}$/u.test(error.code)
            ? error.code
            : "unknown";
        observe("worker_endpoint_operation_get", "failed", {
          poll,
          operation_id_hash: operationHash,
          http_code: code,
        });
        throw new DiagnosticFailure("worker_endpoint_operation_get", `terminal_${code}`);
      }
      const result = objectAt(state, "result", "worker_endpoint_operation_get");
      const resource = objectAt(result, "resource", "worker_endpoint_operation_get");
      if (resource.apiVersion !== input.apiVersion) {
        throw new DiagnosticFailure(input.stage, "resource_identity_mismatch");
      }
      const uid = assertResourceIdentity(
        resource,
        input.apiVersion,
        input.kind,
        input.name,
        input.stage,
      );
      observe("worker_endpoint_operation_get", "ok", {
        poll,
        operation_id_hash: operationHash,
        resource_uid_hash: digestIdentity(uid),
        elapsed_ms: Math.round(performance.now() - input.startedAt),
      });
      return resource;
    }
    if (state.done !== false) {
      throw new DiagnosticFailure("worker_endpoint_operation_get", "operation_state_invalid");
    }
    observe("worker_endpoint_operation_get", "ok", {
      poll,
      operation_id_hash: operationHash,
      http_code: "pending",
    });
    delay = retryAfterDelay(response.headers, poll);
  }
  observe("worker_endpoint_operation_get", "failed", {
    poll,
    operation_id_hash: operationHash,
    elapsed_ms: Math.round(performance.now() - input.startedAt),
  });
  throw new DiagnosticFailure(
    "worker_endpoint_operation_get",
    poll >= maxPolls ? "poll_limit_exhausted" : "terminal_budget_exhausted",
  );
}

function retryAfterDelay(headers: Headers, attempt: number): number {
  const value = headers.get("retry-after");
  if (value === null) {
    return Math.min(3_000, DEFAULT_OPERATION_RETRY_AFTER_MS * 2 ** Math.min(attempt, 2));
  }
  if (!/^(0|[1-9][0-9]*)$/u.test(value)) {
    throw new DiagnosticFailure("worker_endpoint_operation_get", "retry_after_invalid");
  }
  const delay = Number(value) * 1_000;
  if (!Number.isSafeInteger(delay)) {
    throw new DiagnosticFailure("worker_endpoint_operation_get", "retry_after_out_of_bounds");
  }
  return delay;
}

test("mutation fetch diagnostics distinguish deadline abort from transport failure", () => {
  const transport = mutationFetchFailure(
    "worker_endpoint_create",
    new AbortController().signal,
    100,
    127,
  );
  expect(transport.category).toBe("mutation_transport_error");
  expect(transport.requestElapsedMs).toBe(27);
  expect(transport.message).toBe(
    "worker_endpoint_public_create_worker_endpoint_create_mutation_transport_error",
  );

  const deadline = new AbortController();
  deadline.abort();
  const timeout = mutationFetchFailure("worker_endpoint_create", deadline.signal, 200, 224);
  expect(timeout.category).toBe("mutation_deadline_exceeded");
  expect(timeout.requestElapsedMs).toBe(24);
  expect(timeout.message).toBe(
    "worker_endpoint_public_create_worker_endpoint_create_mutation_deadline_exceeded",
  );
});

test.skipIf(NATIVE_OPT_IN === undefined || WORKERD === undefined)(
  "a real public Host WorkerEndpoint create returns a resource or resolves its exact deferred operation",
  async () => {
    if (NATIVE_OPT_IN !== "1") {
      throw new DiagnosticFailure("isolation_preflight", "opt_in_must_be_exactly_one");
    }
    await assertIsolatedSelfhostNativeEnvironment({ fixedPorts: [API_PORT, CORE_PORT, 443] });
    observe("isolation_preflight", "ok");

    const root = mkdtempSync(join(tmpdir(), "wendpoint-"));
    const dataRoot = join(root, "data");
    const dbDirectory = join(root, "control-db");
    const dbPath = join(dbDirectory, "control.sqlite");
    const tlsDirectory = join(root, "tls");
    const baseEnv = childEnvironment(root);
    const hostEnv = () => ({
      ...baseEnv,
      TAKOSERVER_DATA_ROOT: dataRoot,
      TAKOSERVER_DB: dbPath,
      TAKOSERVER_PUBLIC_ORIGIN: HOST_ORIGIN,
      PORT: String(API_PORT),
      TAKOSERVER_WORKERD_BINARY: WORKERD as string,
      TAKOSERVER_WORKERD_PORT: "443",
      TAKOSERVER_WORKER_ENDPOINT_PORT: "443",
      TAKOSERVER_WORKER_ENDPOINT_SUFFIX: WORKER_SUFFIX,
      TAKOSERVER_WORKERD_TLS_CERT_FILE: join(tlsDirectory, "worker-cert.pem"),
      TAKOSERVER_WORKERD_TLS_KEY_FILE: join(tlsDirectory, "worker-key.pem"),
    });

    let verifier: Child | undefined;
    let host: Host | undefined;
    let admission: Child | undefined;
    let mutationStarted = false;
    let preserved = false;
    let cleanupUnknown = false;
    let cleanupArtifactFailure: "root_remove_failed" | "custody_pointer_remove_failed" | undefined;
    let custodyPointer: string | undefined;
    let currentStage: SafeStage = "core_verifier_startup";
    const startedAt = performance.now();
    try {
      chmodSync(root, 0o700);
      mkdirSync(dataRoot, { recursive: true, mode: 0o700 });
      mkdirSync(dbDirectory, { recursive: true, mode: 0o700 });
      mkdirSync(tlsDirectory, { recursive: true, mode: 0o700 });
      custodyPointer = writeCustodyPointer(root);
      observe(currentStage, "start");
      const coreDigest = takoformCoreVerifierArtifactDigest();
      let coreBinary: string;
      try {
        coreBinary = buildRealCoreVerifier(join(root, "core-verifier"));
      } catch {
        throw new DiagnosticFailure(currentStage, "verifier_build_failed");
      }
      verifier = Bun.spawn([coreBinary], {
        cwd: process.cwd(),
        env: {
          ...baseEnv,
          TAKOFORM_CORE_VERIFIER_ARTIFACT_DIGEST: coreDigest,
        },
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      });
      await assertIsolatedSelfhostNativeEnvironment({ fixedPorts: [], ownedChild: verifier });
      await waitForCore(verifier, coreDigest);
      observe(currentStage, "ok", { elapsed_ms: Math.round(performance.now() - startedAt) });

      currentStage = "initial_host_management";
      observe(currentStage, "start");
      await createTls(tlsDirectory);
      await assertIsolatedSelfhostNativeEnvironment({
        fixedPorts: [API_PORT, 443],
        ownedChild: verifier,
      });
      host = startHost(hostEnv());
      await assertIsolatedSelfhostNativeEnvironment({ fixedPorts: [], ownedChild: host });
      await waitForHost(host, currentStage);
      const assertion = await signOperatorAssertion({
        privateJwk: readFileSync(join(dataRoot, "operator-key.jwk"), "utf8"),
        claims: {
          purpose: "sign-in",
          aud: HOST_ORIGIN,
          provider: "google",
          subject: "worker-endpoint-public-diagnostic-operator",
          email: "worker-endpoint-public-diagnostic@localhost",
          displayName: "WorkerEndpoint Public Diagnostic",
        },
        nowSeconds: Math.floor(Date.now() / 1_000),
        lifetimeSeconds: 60,
      });
      const session = await expectJson(
        "POST",
        "/v1/sessions",
        {
          provider: "google",
          method: "operator-assertion",
          assertion,
          sessionTtlSeconds: 60,
        },
        {},
        200,
        currentStage,
      );
      const sessionToken = stringAt(session, "sessionToken", currentStage);
      const organization = await expectJson(
        "POST",
        "/v1/organizations",
        { name: "WorkerEndpoint Public Diagnostic" },
        { authorization: `Bearer ${sessionToken}` },
        201,
        currentStage,
      );
      const organizationId = stringAt(
        objectAt(organization, "organization", currentStage),
        "id",
        currentStage,
      );
      const keyResponse = await expectJson(
        "POST",
        `/v1/organizations/${encodeURIComponent(organizationId)}/api-keys`,
        {
          name: "worker-endpoint-public-diagnostic",
          scopes: API_KEY_SCOPES,
          expiresInSeconds: 600,
        },
        { authorization: `Bearer ${sessionToken}` },
        201,
        currentStage,
      );
      const auth = {
        authorization: `Bearer ${stringAt(keyResponse, "secret", currentStage)}`,
        "takoform-organization": organizationId,
      };
      await stopChild(host, currentStage);
      host = undefined;
      observe(currentStage, "ok");

      currentStage = "form_admission";
      observe(currentStage, "start");
      await verifyAndAdmit(organizationId, dataRoot, hostEnv(), (child) => {
        admission = child;
      });
      admission = undefined;
      observe(currentStage, "ok");

      currentStage = "admitted_host_startup";
      observe(currentStage, "start");
      await assertIsolatedSelfhostNativeEnvironment({
        fixedPorts: [API_PORT, 443],
        ownedChild: verifier,
      });
      host = startHost(hostEnv());
      await assertIsolatedSelfhostNativeEnvironment({ fixedPorts: [], ownedChild: host });
      await waitForHost(host, currentStage);
      observe(currentStage, "ok");

      currentStage = "form_discovery";
      observe(currentStage, "start");
      const discovery = await expectJson(
        "GET",
        `${LANE}/forms?space=${SPACE}`,
        undefined,
        auth,
        200,
        currentStage,
      );
      const forms = new Map<string, Json>();
      if (!Array.isArray(discovery.forms))
        throw new DiagnosticFailure(currentStage, "forms_missing");
      for (const item of discovery.forms) {
        if (item === null || typeof item !== "object" || Array.isArray(item)) continue;
        const identity = objectAt(item as Json, "identity", currentStage);
        const form = objectAt(identity, "formRef", currentStage);
        if (typeof form.kind === "string") forms.set(form.kind, form);
      }
      for (const kind of [
        "ModuleWorker",
        "WorkerBundle",
        "WorkerVersion",
        "WorkerDeployment",
        "WorkerEndpoint",
      ]) {
        if (!forms.has(kind)) throw new DiagnosticFailure(currentStage, `form_missing_${kind}`);
      }
      observe(currentStage, "ok");

      const addKnownResource = async (
        kind: string,
        name: string,
        spec: Json,
        stage: SafeStage,
      ): Promise<Json> => {
        const form = forms.get(kind);
        if (!form) throw new DiagnosticFailure(stage, "form_missing");
        observe(stage, "start");
        return await createWithReceipt({
          auth,
          form,
          kind,
          name,
          spec,
          stage,
          operationBudgetMs: SETUP_OPERATION_BUDGET_MS,
          idempotencyKey: `worker-endpoint-public-create:${kind}:v1`,
          onMutationStart: () => {
            mutationStarted = true;
          },
        });
      };

      currentStage = "module_artifact_upload";
      observe(currentStage, "start");
      const moduleBytes = new TextEncoder().encode(MODULE_SOURCE);
      const moduleDigest = await bytesDigest(moduleBytes);
      mutationStarted = true;
      const upload = await expectJson(
        "POST",
        `${LANE}/artifacts/uploads`,
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
        { ...auth, "idempotency-key": "worker-endpoint-public-create:upload:v1" },
        201,
        currentStage,
        MUTATION_RESPONSE_TIMEOUT_MS,
      );
      const uploadId = stringAt(upload, "uploadId", currentStage);
      if (!Array.isArray(upload.missingBlobs) || !upload.missingBlobs.includes(moduleDigest)) {
        throw new DiagnosticFailure(currentStage, "module_blob_not_requested");
      }
      let blob: Response;
      try {
        blob = await fetch(
          `${HOST_ORIGIN}${LANE}/artifacts/uploads/${encodeURIComponent(uploadId)}/blobs/${moduleDigest}`,
          {
            method: "PUT",
            headers: auth,
            body: moduleBytes,
            signal: AbortSignal.timeout(MUTATION_RESPONSE_TIMEOUT_MS),
          },
        );
      } catch {
        throw new DiagnosticFailure(currentStage, "blob_upload_unknown");
      }
      if (blob.status !== 201)
        throw new DiagnosticFailure(currentStage, "blob_upload_failed", blob.status);
      await blob.arrayBuffer();
      const committed = await expectJson(
        "POST",
        `${LANE}/artifacts/uploads/${encodeURIComponent(uploadId)}/commit`,
        undefined,
        { ...auth, "idempotency-key": "worker-endpoint-public-create:commit:v1" },
        201,
        currentStage,
        MUTATION_RESPONSE_TIMEOUT_MS,
      );
      const bundleDigest = stringAt(committed, "manifestDigest", currentStage);
      observe(currentStage, "ok");

      const workerName = "worker-endpoint-public-diagnostic-worker";
      const bundleName = "worker-endpoint-public-diagnostic-bundle";
      const versionName = "worker-endpoint-public-diagnostic-version";
      const deploymentName = "worker-endpoint-public-diagnostic-deployment";
      const moduleWorker = await addKnownResource(
        "ModuleWorker",
        workerName,
        {},
        "module_worker_create",
      );
      const workerBundle = await addKnownResource(
        "WorkerBundle",
        bundleName,
        { manifestDigest: bundleDigest },
        "worker_bundle_create",
      );
      const version = await addKnownResource(
        "WorkerVersion",
        versionName,
        {
          worker: reference(forms.get("ModuleWorker") as Json, "ModuleWorker", workerName),
          bundle: reference(forms.get("WorkerBundle") as Json, "WorkerBundle", bundleName),
          handlers: ["fetch"],
          requiredSensitiveVars: [],
          bucketBindings: [],
        },
        "worker_version_create",
      );
      await addKnownResource(
        "WorkerDeployment",
        deploymentName,
        {
          worker: reference(forms.get("ModuleWorker") as Json, "ModuleWorker", workerName),
          versions: [
            {
              workerVersion: reference(
                forms.get("WorkerVersion") as Json,
                "WorkerVersion",
                versionName,
              ),
              weight: 10_000,
            },
          ],
        },
        "worker_deployment_create",
      );
      // The prerequisite graph exists before the diagnostic endpoint request.
      assertResourceIdentity(
        moduleWorker,
        expectedApiVersion(forms.get("ModuleWorker") as Json),
        "ModuleWorker",
        workerName,
        "module_worker_create",
      );
      assertResourceIdentity(
        workerBundle,
        expectedApiVersion(forms.get("WorkerBundle") as Json),
        "WorkerBundle",
        bundleName,
        "worker_bundle_create",
      );
      assertResourceIdentity(
        version,
        expectedApiVersion(forms.get("WorkerVersion") as Json),
        "WorkerVersion",
        versionName,
        "worker_version_create",
      );

      currentStage = "worker_endpoint_create";
      const endpointName = "worker-endpoint-public-diagnostic-endpoint";
      const endpointForm = forms.get("WorkerEndpoint");
      if (!endpointForm) throw new DiagnosticFailure(currentStage, "form_missing");
      observe(currentStage, "start");
      const endpoint = await createWithReceipt({
        auth,
        form: endpointForm,
        kind: "WorkerEndpoint",
        name: endpointName,
        spec: { worker: reference(forms.get("ModuleWorker") as Json, "ModuleWorker", workerName) },
        stage: currentStage,
        operationBudgetMs: ENDPOINT_OPERATION_BUDGET_MS,
        idempotencyKey: "worker-endpoint-public-create:worker-endpoint:v1",
        onMutationStart: () => {
          mutationStarted = true;
        },
      });
      const endpointUid = assertResourceIdentity(
        endpoint,
        expectedApiVersion(endpointForm),
        "WorkerEndpoint",
        endpointName,
        currentStage,
      );
      observe(currentStage, "ok", { resource_uid_hash: digestIdentity(endpointUid) });

      currentStage = "worker_endpoint_resource_readback";
      observe(currentStage, "start");
      const endpointPath = `${LANE}/resources/${expectedApiVersion(endpointForm)}/WorkerEndpoint/${endpointName}?${formQuery(endpointForm)}`;
      const readback = await expectJson("GET", endpointPath, undefined, auth, 200, currentStage);
      const readbackUid = assertResourceIdentity(
        readback,
        expectedApiVersion(endpointForm),
        "WorkerEndpoint",
        endpointName,
        currentStage,
      );
      if (readbackUid !== endpointUid) {
        throw new DiagnosticFailure(currentStage, "resource_uid_changed");
      }
      const outputs = objectAt(objectAt(readback, "status", currentStage), "outputs", currentStage);
      const endpointUrl = stringAt(outputs, "url", currentStage);
      const parsedUrl = new URL(endpointUrl);
      if (
        parsedUrl.protocol !== "https:" ||
        parsedUrl.port !== "" ||
        parsedUrl.username !== "" ||
        parsedUrl.password !== "" ||
        parsedUrl.pathname !== "/" ||
        parsedUrl.search !== "" ||
        parsedUrl.hash !== "" ||
        !parsedUrl.hostname.endsWith(`.${WORKER_SUFFIX}`)
      ) {
        throw new DiagnosticFailure(currentStage, "endpoint_output_not_canonical_https");
      }
      observe(currentStage, "ok", { resource_uid_hash: digestIdentity(readbackUid) });
      mutationStarted = false;
    } catch (error) {
      preserved = mutationStarted;
      const safe =
        error instanceof DiagnosticFailure
          ? error
          : new DiagnosticFailure(currentStage, "unexpected_failure");
      observe(safe.stage, "failed", {
        ...(safe.status === undefined ? {} : { status: safe.status }),
        elapsed_ms: Math.round(performance.now() - startedAt),
        ...(safe.requestElapsedMs === undefined
          ? {}
          : { request_elapsed_ms: safe.requestElapsedMs }),
        http_code: safe.category,
      });
      if (preserved) {
        console.info("[worker-endpoint-public-create] custody=preserved_after_mutation_start");
      }
      throw safe;
    } finally {
      for (const [child, stage] of [
        [admission, "form_admission"],
        [host, currentStage],
        [verifier, "core_verifier_startup"],
      ] as const) {
        if (!child) continue;
        try {
          await stopChild(child, stage);
        } catch {
          cleanupUnknown = true;
          observe("fixture_cleanup", "failed", { http_code: "owned_child_exit_unknown" });
        }
      }
      if (!preserved && !cleanupUnknown) {
        observe("fixture_cleanup", "start");
        try {
          rmSync(root, { recursive: true, force: true });
        } catch {
          cleanupArtifactFailure = "root_remove_failed";
          observe("fixture_cleanup", "failed", { http_code: "root_remove_failed" });
          console.info(
            "[worker-endpoint-public-create] custody=root_retained_after_cleanup_failure",
          );
        }
        if (!cleanupArtifactFailure && custodyPointer) {
          try {
            rmSync(custodyPointer, { force: true });
          } catch {
            cleanupArtifactFailure = "custody_pointer_remove_failed";
            observe("fixture_cleanup", "failed", { http_code: "custody_pointer_remove_failed" });
            console.info(
              "[worker-endpoint-public-create] custody_pointer=retained_after_cleanup_failure",
            );
          }
        }
        if (!cleanupArtifactFailure) observe("fixture_cleanup", "ok");
      } else {
        console.info(
          `[worker-endpoint-public-create] custody=${cleanupUnknown ? "root_retained_after_cleanup_uncertainty" : "root_retained_for_readonly_recovery"}`,
        );
      }
    }
    if (cleanupUnknown) throw new DiagnosticFailure("fixture_cleanup", "owned_child_exit_unknown");
    if (cleanupArtifactFailure) {
      throw new DiagnosticFailure("fixture_cleanup", cleanupArtifactFailure);
    }
  },
  600_000,
);
