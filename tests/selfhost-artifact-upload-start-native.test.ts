import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { connect as connectTcp } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEphemeralSql } from "../src/compat.ts";
import { bytesDigest } from "../src/json.ts";
import { createMemoryObjectStore } from "../src/objects-mem.ts";
import { signOperatorAssertion } from "../src/operator-key.ts";
import { createTakoformArtifacts } from "../src/takoform/artifacts.ts";
import { assertIsolatedSelfhostNativeEnvironment } from "./helpers/isolated-selfhost-native.ts";

const HOST_ORIGIN = "http://127.0.0.1:8787";
const HOST_PORT = 8787;
const LANE = "/apis/forms.takoform.com/v1";
const NATIVE_OPT_IN = process.env.TAKOSERVER_SELFHOST_ARTIFACT_UPLOAD_NATIVE === "1";
const REQUEST_TIMEOUT_MS = 10_000;
const READINESS_TIMEOUT_MS = 15_000;
const HOST_STOP_TIMEOUT_MS = 5_000;
const FIXTURE_PREFIX = "takoserver-selfhost-artifact-upload-";
const V1_MODULE = new TextEncoder().encode(
  "export default { fetch() { return new Response('v1'); } };",
);
const V2_MODULE = new TextEncoder().encode(
  "export default { fetch() { return new Response('v2'); } };",
);

type Json = Record<string, unknown>;
type Host = ReturnType<typeof Bun.spawn>;
type PhaseMarker = (phase: string, outcome: string) => void;

test.skipIf(!NATIVE_OPT_IN)(
  "a real self-host accepts successive V1 and V2 artifact upload starts without an admitted Form",
  async () => {
    await assertIsolatedSelfhostNativeEnvironment({ fixedPorts: [HOST_PORT] });
    const fixture = mkdtempSync(join(tmpdir(), FIXTURE_PREFIX));
    chmodSync(fixture, 0o700);
    const dataRoot = join(fixture, "data");
    const databaseDirectory = join(fixture, "control-db");
    const databasePath = join(databaseDirectory, "control.sqlite");
    mkdirSync(dataRoot, { recursive: true, mode: 0o700 });
    mkdirSync(databaseDirectory, { recursive: true, mode: 0o700 });

    const startedAt = performance.now();
    const mark = (phase: string, outcome: string): void => {
      if (
        !/^(?:host_start|host_ready|operator_session|organization|api_key|v1_start|v1_blob|v1_commit|v2_start|host_stop|receipt_check|fixture_cleanup)$/u.test(
          phase,
        )
      ) {
        throw new Error("artifact_diagnostic_invalid_phase");
      }
      if (
        !/^(?:ok|timeout|http_error|error|not_reached|exists|absent|unknown|removed|preserved)$/u.test(
          outcome,
        )
      ) {
        throw new Error("artifact_diagnostic_invalid_outcome");
      }
      console.log(
        `[selfhost-artifact-upload-start] phase=${phase} outcome=${outcome} wall_ms=${Math.round(performance.now() - startedAt)}`,
      );
    };
    const hostEnvironment = {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: fixture,
      TMPDIR: process.env.TMPDIR ?? fixture,
      CI: "1",
      NO_COLOR: "1",
      CHECKPOINT_DISABLE: "1",
      TAKOSERVER_DATA_ROOT: dataRoot,
      TAKOSERVER_DB: databasePath,
      TAKOSERVER_PUBLIC_ORIGIN: HOST_ORIGIN,
      PORT: String(HOST_PORT),
    };

    let host: Host | undefined;
    let primaryFailure: string | undefined;
    let v2Outcome: "not_reached" | "ok" | "timeout" | "http_error" | "error" = "not_reached";
    let v2Attempted = false;
    let v2ReplayKey: string | undefined;
    let cleanupFailure: string | undefined;
    const operationKey = `selfhost-artifact-v2-${crypto.randomUUID()}`;

    try {
      host = Bun.spawn([process.execPath, "--no-env-file", "src/entry-bun.ts"], {
        cwd: process.cwd(),
        env: hostEnvironment,
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      });
      await assertIsolatedSelfhostNativeEnvironment({ fixedPorts: [], ownedChild: host });
      mark("host_start", "ok");
      await waitForHost(host);
      await assertIsolatedSelfhostNativeEnvironment({ fixedPorts: [], ownedChild: host });
      mark("host_ready", "ok");

      const operatorPrivateJwk = readFileSync(join(dataRoot, "operator-key.jwk"), "utf8");
      const assertion = await signOperatorAssertion({
        privateJwk: operatorPrivateJwk,
        claims: {
          purpose: "sign-in",
          aud: HOST_ORIGIN,
          provider: "google",
          subject: "artifact-upload-native-operator",
          email: "artifact-upload@localhost",
          displayName: "Artifact Upload Operator",
        },
        nowSeconds: Math.floor(Date.now() / 1_000),
        lifetimeSeconds: 60,
      });
      const session = await requestJson<Json>("POST", "/v1/sessions", 200, {
        provider: "google",
        method: "operator-assertion",
        assertion,
        sessionTtlSeconds: 60,
      });
      mark("operator_session", "ok");
      const sessionToken = stringAt(session, "sessionToken");
      const created = await requestJson<Json>(
        "POST",
        "/v1/organizations",
        201,
        { name: "Self-host artifact upload diagnostic" },
        { authorization: `Bearer ${sessionToken}` },
      );
      mark("organization", "ok");
      const organizationId = stringAt(objectAt(created, "organization"), "id");
      const apiKey = await requestJson<Json>(
        "POST",
        `/v1/organizations/${encodeURIComponent(organizationId)}/api-keys`,
        201,
        {
          name: "artifact-upload-native",
          scopes: ["resources:read", "resources:write"],
          expiresInSeconds: 600,
        },
        { authorization: `Bearer ${sessionToken}` },
      );
      mark("api_key", "ok");
      const apiKeyId = stringAt(objectAt(apiKey, "apiKey"), "id");
      const auth = {
        authorization: `Bearer ${stringAt(apiKey, "secret")}`,
        "takoform-organization": organizationId,
      };

      await publishModuleArtifact(V1_MODULE, "selfhost-artifact-v1", auth, mark);
      // routes authenticate API keys as `api-key:${id}` principal IDs; artifacts.ts
      // keys start replays as [tenant, principal, "start", idempotencyKey].
      v2ReplayKey = [organizationId, `api-key:${apiKeyId}`, "start", operationKey].join("\u0000");

      try {
        v2Attempted = true;
        const v2 = await startModuleArtifact(V2_MODULE, operationKey, auth);
        expect(v2.missingBlobs.includes(v2.digest)).toBe(true);
        v2Outcome = "ok";
        mark("v2_start", "ok");
      } catch (error) {
        v2Outcome =
          error instanceof DOMException && error.name === "TimeoutError"
            ? "timeout"
            : error instanceof Error && error.message === "selfhost_api_status"
              ? "http_error"
              : "error";
        mark("v2_start", v2Outcome);
      }

      if (v2Outcome !== "ok") {
        primaryFailure = `selfhost_v2_upload_start_${v2Outcome}`;
      }
    } catch (error) {
      primaryFailure = safeFailureTag(error);
      if (v2Outcome === "not_reached") mark("v2_start", "not_reached");
    } finally {
      if (host) {
        try {
          await stopHost(host);
          mark("host_stop", "ok");
        } catch {
          cleanupFailure = "selfhost_host_stop_unconfirmed";
          mark("host_stop", "unknown");
        }
      }

      if (
        v2Attempted &&
        v2Outcome !== "ok" &&
        v2ReplayKey !== undefined &&
        !cleanupFailure &&
        existsSync(databasePath)
      ) {
        try {
          mark("receipt_check", hasReplayReceipt(databasePath, v2ReplayKey) ? "exists" : "absent");
        } catch {
          cleanupFailure = "selfhost_readonly_receipt_check_failed";
          mark("receipt_check", "unknown");
        }
      }

      let portClosed = false;
      if (!cleanupFailure && (!host || host.exitCode !== null)) {
        try {
          portClosed = await tcpPortIsClosed(HOST_PORT);
        } catch {
          cleanupFailure = "selfhost_listener_close_unconfirmed";
        }
      }
      if (!cleanupFailure && portClosed) {
        try {
          rmSync(fixture, { recursive: true, force: false });
          mark("fixture_cleanup", "removed");
        } catch {
          cleanupFailure = "selfhost_fixture_cleanup_failed";
          mark("fixture_cleanup", "preserved");
        }
      } else {
        cleanupFailure ??= "selfhost_fixture_preserved_until_cleanup_is_confirmed";
        mark("fixture_cleanup", "preserved");
      }
    }

    if (cleanupFailure) throw new Error(cleanupFailure);
    if (primaryFailure) throw new Error(primaryFailure);
    expect(v2Outcome).toBe("ok");
  },
  180_000,
);

async function publishModuleArtifact(
  bytes: Uint8Array,
  idempotencyPrefix: string,
  auth: Record<string, string>,
  mark: PhaseMarker,
): Promise<void> {
  const started = await startModuleArtifact(bytes, `${idempotencyPrefix}-upload`, auth);
  mark("v1_start", "ok");
  expect(started.missingBlobs.includes(started.digest)).toBe(true);
  const blob = await fetch(`${HOST_ORIGIN}${artifactBlobPath(started.uploadId, started.digest)}`, {
    method: "PUT",
    headers: auth,
    body: bytes as unknown as BodyInit,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  expect(blob.status).toBe(201);
  await blob.arrayBuffer();
  mark("v1_blob", "ok");
  await requestJson<Json>(
    "POST",
    `${LANE}/artifacts/uploads/${encodeURIComponent(started.uploadId)}/commit`,
    201,
    undefined,
    { ...auth, "idempotency-key": `${idempotencyPrefix}-commit` },
  );
  mark("v1_commit", "ok");
}

async function startModuleArtifact(
  bytes: Uint8Array,
  idempotencyKey: string,
  auth: Record<string, string>,
): Promise<{
  readonly uploadId: string;
  readonly digest: string;
  readonly missingBlobs: unknown[];
}> {
  const digest = await bytesDigest(bytes);
  const upload = await requestJson<Json>(
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
    { ...auth, "idempotency-key": idempotencyKey },
  );
  const missingBlobs = upload.missingBlobs;
  if (!Array.isArray(missingBlobs)) throw new Error("selfhost_missing_blobs_shape");
  return { uploadId: stringAt(upload, "uploadId"), digest, missingBlobs };
}

test("artifact blob URL preserves the literal digest colon required by the real handler", async () => {
  const bytes = new TextEncoder().encode("portable artifact URL contract");
  const digest = await bytesDigest(bytes);
  let id = 0;
  const artifacts = createTakoformArtifacts({
    sql: createEphemeralSql(),
    objects: createMemoryObjectStore(),
    clock: () => new Date("2026-10-02T00:00:00.000Z"),
    randomId: () => `artifact-${++id}`,
  });
  const principal = { tenantId: "tenant-test", principalId: "api-key:artifact-url-test" };
  const failure = (code: string, status: number) => Response.json({ error: { code } }, { status });
  const started = await artifacts.handle(
    new Request(`https://api.test${LANE}/artifacts/uploads`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "artifact-url-start" },
      body: JSON.stringify({
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
      }),
    }),
    principal,
    failure,
  );
  expect(started?.status).toBe(201);
  if (!started) throw new Error("artifact_start_route_missing");
  const startBody = (await started.json()) as Json;
  const uploadId = stringAt(startBody, "uploadId");

  const encoded = await artifacts.handle(
    new Request(
      `https://api.test${LANE}/artifacts/uploads/${encodeURIComponent(uploadId)}/blobs/${encodeURIComponent(digest)}`,
      { method: "PUT", body: bytes as unknown as BodyInit },
    ),
    principal,
    failure,
  );
  expect(encoded?.status).toBe(400);

  const canonical = await artifacts.handle(
    new Request(`https://api.test${artifactBlobPath(uploadId, digest)}`, {
      method: "PUT",
      body: bytes as unknown as BodyInit,
    }),
    principal,
    failure,
  );
  expect(canonical?.status).toBe(201);
});

async function requestJson<T extends Json>(
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
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (response.status !== expectedStatus) {
    await response.arrayBuffer().catch(() => undefined);
    throw new Error("selfhost_api_status");
  }
  return (await response.json()) as T;
}

async function waitForHost(host: Host): Promise<void> {
  const deadline = Date.now() + READINESS_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (host.exitCode !== null) throw new Error("selfhost_startup_exit");
    try {
      const response = await fetch(`${HOST_ORIGIN}/.well-known/takoform/v1`, {
        signal: AbortSignal.timeout(500),
      });
      await response.arrayBuffer();
      if (response.ok) return;
    } catch {
      // Readiness is established only by the real Host listener.
    }
    await Bun.sleep(50);
  }
  throw new Error("selfhost_api_listener_not_ready");
}

async function stopHost(host: Host): Promise<void> {
  if (host.exitCode === null) {
    host.kill("SIGTERM");
    const exitCode = await Promise.race([
      host.exited,
      Bun.sleep(HOST_STOP_TIMEOUT_MS).then(() => null),
    ]);
    if (exitCode === null) throw new Error("selfhost_host_stop_timeout");
    if (exitCode !== 0) throw new Error("selfhost_host_exit_nonzero");
  } else if ((await host.exited) !== 0) {
    throw new Error("selfhost_host_exit_nonzero");
  }
  if (!(await tcpPortIsClosed(HOST_PORT))) throw new Error("selfhost_listener_still_open");
}

function hasReplayReceipt(databasePath: string, replayKey: string): boolean {
  const database = new Database(databasePath, { readonly: true });
  try {
    const row = database
      .query(
        "SELECT EXISTS(SELECT 1 FROM tf_artifact_replays WHERE replay_key = ? AND expires_at > ?) AS present",
      )
      .get(replayKey, Date.now()) as { present: number };
    return row.present === 1;
  } finally {
    database.close();
  }
}

function artifactBlobPath(uploadId: string, digest: string): string {
  return `${LANE}/artifacts/uploads/${encodeURIComponent(uploadId)}/blobs/${digest}`;
}

function tcpPortIsClosed(port: number): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const socket = connectTcp({ host: "127.0.0.1", port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("selfhost_listener_probe_timeout"));
    }, 250);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(false);
    });
    socket.once("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (error.code === "ECONNREFUSED") resolve(true);
      else reject(new Error("selfhost_listener_probe_error"));
    });
  });
}

function objectAt(value: Json, key: string): Json {
  const candidate = value[key];
  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new Error("selfhost_response_shape");
  }
  return candidate as Json;
}

function stringAt(value: Json, key: string): string {
  const candidate = value[key];
  if (typeof candidate !== "string" || candidate.length === 0) {
    throw new Error("selfhost_response_shape");
  }
  return candidate;
}

function safeFailureTag(error: unknown): string {
  if (error instanceof DOMException && error.name === "TimeoutError") {
    return "selfhost_request_timeout";
  }
  if (error instanceof Error && /^[a-z0-9_]+$/u.test(error.message)) return error.message;
  return "selfhost_artifact_upload_diagnostic_failed";
}
