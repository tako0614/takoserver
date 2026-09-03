import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { ARTIFACT_RECOVERY_RPC_KIND } from "../../src/artifact-recovery-worker.ts";
import { canonicalJson } from "../../src/json.ts";
import { parseStrictJson } from "../../src/strict-json.ts";
import {
  type CanonicalArtifactRecoveryRequest,
  canonicalArtifactRecoveryApplyResult,
  canonicalArtifactRecoveryReadback,
  canonicalArtifactRecoveryRequest,
} from "../../src/takoform/artifact-recovery.ts";
import { CloudflareState } from "./cloudflare-state.ts";
import { DeployError, mutationError, preflightError, verificationError } from "./errors.ts";
import {
  type CommandResult,
  cloudflareChildEnvironment,
  REPOSITORY,
  requireEnvironment,
  runCommand,
  sanitizedChildEnvironment,
  WRANGLER,
} from "./process.ts";
import {
  type DeployEnvironment,
  type QualificationProcess,
  qualifySource,
} from "./qualification.ts";
import type { DeployTarget } from "./target.ts";
import {
  inspectLiveWorkerVersion,
  type LiveWorkerVersion,
  type WorkerState,
} from "./worker-live.ts";

const STATUS_TIMEOUT_MILLISECONDS = 30_000;
const APPLY_TIMEOUT_MILLISECONDS = 55_000;
const READY_TIMEOUT_MILLISECONDS = 30_000;
const CHILD_EXIT_TIMEOUT_MILLISECONDS = 5_000;
const MAXIMUM_RESPONSE_BYTES = 2 * 1_024 * 1_024;
const REQUEST_PATH_ENVIRONMENT = "TAKOSERVER_ARTIFACT_RECOVERY_REQUEST_PATH";

export interface ExactArtifactRecoveryInvocation {
  readonly surface: "takoserver-integration-exact-failed-run-artifact-recovery";
  readonly action: "status" | "apply";
  readonly environment: DeployEnvironment;
  readonly commit: string;
}

export interface RecoveryCallerSession {
  call(input: unknown, timeoutMilliseconds: number): Promise<unknown>;
  close(): Promise<void>;
}

export interface ExactArtifactRecoveryDeployOptions {
  readonly requestPath?: string;
  readonly review?: string;
  readonly run?: QualificationProcess;
  readonly state?: WorkerState;
  readonly cloudflareEnvironment?: Readonly<Record<string, string>>;
  readonly inspectLive?: () => Promise<LiveWorkerVersion>;
  readonly openCaller?: (input: {
    readonly target: DeployTarget;
    readonly tokenEnvironment: Readonly<Record<string, string>>;
  }) => Promise<RecoveryCallerSession>;
}

/**
 * Integration owner surface. Neither action receives a D1/R2 credential:
 * status/apply both cross the live Worker's named RPC through one ephemeral
 * loopback caller, and apply is never retried inside this command.
 */
export async function runExactArtifactRecovery(
  invocation: ExactArtifactRecoveryInvocation,
  target: DeployTarget,
  options: ExactArtifactRecoveryDeployOptions = {},
): Promise<Record<string, unknown>> {
  assertIntegration(invocation, target);
  const run = options.run ?? runCommand;
  const source = await qualifySource({
    environment: "integration",
    commit: invocation.commit,
    run,
  });
  if (source.dirty) {
    throw preflightError(
      "exact failed-run artifact recovery requires a clean worktree",
      JSON.stringify(source.changedPaths),
    );
  }
  const request = await readRecoveryRequest(
    options.requestPath ?? requireEnvironment(REQUEST_PATH_ENVIRONMENT),
  );
  const reviewer =
    invocation.action === "apply"
      ? exactReviewer(options.review ?? requireEnvironment("TAKOSERVER_INDEPENDENT_REVIEW"))
      : undefined;
  if (!target.integrationE2eCredentialAuthority) {
    throw preflightError(
      "exact artifact recovery requires the provenance-bound integration Worker profile",
    );
  }
  const tokenEnvironment =
    options.cloudflareEnvironment ??
    (options.inspectLive !== undefined && options.openCaller !== undefined
      ? {}
      : cloudflareChildEnvironment());
  const state =
    options.state ??
    new CloudflareState({
      accountId: target.accountId,
      token: exactCloudflareToken(tokenEnvironment),
    });
  const inspect = async (phase: "preflight" | "verification"): Promise<LiveWorkerVersion> => {
    try {
      return options.inspectLive !== undefined
        ? await options.inspectLive()
        : await inspectLiveWorkerVersion(phase, target, state, {
            authorityProfile: { kind: "provenance-bound-jit" },
          });
    } catch (error) {
      if (error instanceof DeployError && error.phase === phase) throw error;
      const detail = error instanceof Error ? error.message : String(error);
      if (phase === "verification") {
        throw verificationError("authoritative live Worker readback failed after mutation", detail);
      }
      throw preflightError("authoritative live Worker preflight failed", detail);
    }
  };
  const selected = await inspect("preflight");
  assertSelectedLive(invocation.commit, selected);

  const rpcTarget = {
    environment: "integration" as const,
    workerVersionId: selected.history.versionId,
    sourceCommit: selected.commit,
    workerArtifactDigest: `sha256:${selected.bundleDigestHex}` as const,
  };
  const rpcInput = {
    kind: ARTIFACT_RECOVERY_RPC_KIND,
    action: invocation.action,
    target: rpcTarget,
    request: request.request,
  };
  const openCaller = options.openCaller ?? openTemporaryRecoveryCaller;
  if (invocation.action === "apply") await runScopedOwnerGate(run);
  const caller = await openCaller({ target, tokenEnvironment });
  let operation: unknown;
  let readback: unknown;
  let operationError: unknown;
  let operationFailed = false;
  try {
    if (invocation.action === "status") {
      operation = await callOwnerRpc(caller, rpcInput, "status", rpcTarget, request);
      readback = operation;
    } else {
      const refenced = await inspect("preflight");
      assertSameLive(selected, refenced, "before mutation", "preflight");
      operation = await callOwnerRpc(caller, rpcInput, "apply", rpcTarget, request);
      const statusInput = { ...rpcInput, action: "status" as const };
      readback = await callOwnerRpc(caller, statusInput, "verification", rpcTarget, request);
    }
  } catch (error) {
    operationFailed = true;
    operationError = error;
  }
  try {
    await caller.close();
  } catch (error) {
    if (!operationFailed) {
      const detail = error instanceof Error ? error.message : String(error);
      operationFailed = true;
      operationError =
        invocation.action === "apply"
          ? verificationError("temporary artifact recovery caller cleanup failed", detail)
          : preflightError("temporary artifact recovery caller cleanup failed", detail);
    }
  }
  if (operationFailed) throw operationError;
  const after = await inspect(invocation.action === "apply" ? "verification" : "preflight");
  assertSameLive(
    selected,
    after,
    invocation.action === "apply" ? "after mutation" : "after status",
    invocation.action === "apply" ? "verification" : "preflight",
  );
  return {
    kind: "takoserver.exact-failed-run-artifact-recovery-owner-result@v1",
    surface: invocation.surface,
    action: invocation.action,
    environment: "integration",
    selectedCommit: invocation.commit,
    workerVersionId: selected.history.versionId,
    workerArtifactDigest: rpcTarget.workerArtifactDigest,
    requestDigest: request.requestDigest,
    receiptId: request.receiptId,
    ...(reviewer === undefined ? {} : { reviewer }),
    operation,
    readback,
  };
}

async function runScopedOwnerGate(run: QualificationProcess): Promise<void> {
  let gate: CommandResult;
  try {
    gate = await run(["bun", "run", "check"]);
  } catch (error) {
    throw preflightError(
      "scoped owner gate `bun run check` could not run",
      error instanceof Error ? error.message : String(error),
    );
  }
  if (gate.exitCode !== 0) {
    throw preflightError(
      `scoped owner gate \`bun run check\` failed (exit ${gate.exitCode})`,
      `${gate.stdout}${gate.stderr}`.trim(),
    );
  }
}

async function callOwnerRpc(
  caller: RecoveryCallerSession,
  input: unknown,
  phase: "status" | "apply" | "verification",
  target: RpcTarget,
  request: CanonicalArtifactRecoveryRequest,
): Promise<unknown> {
  try {
    return await exactRpcResult(
      await caller.call(
        input,
        phase === "apply" ? APPLY_TIMEOUT_MILLISECONDS : STATUS_TIMEOUT_MILLISECONDS,
      ),
      phase === "apply" ? "apply" : "status",
      target,
      request,
    );
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (phase === "status") throw preflightError("artifact recovery status RPC failed", detail);
    if (phase === "verification") {
      throw verificationError("artifact recovery post-apply status RPC failed", detail);
    }
    throw mutationError(
      "artifact recovery apply is indeterminate; do not retry before authoritative --status",
      detail,
    );
  }
}

async function readRecoveryRequest(path: string): Promise<CanonicalArtifactRecoveryRequest> {
  if (!isAbsolute(path)) throw preflightError(`${REQUEST_PATH_ENVIRONMENT} must be absolute`);
  let link: ReturnType<typeof lstatSync>;
  let status: ReturnType<typeof fstatSync>;
  let canonical: string;
  let bytes: Uint8Array;
  let descriptor: number | undefined;
  try {
    link = lstatSync(path);
    canonical = realpathSync(path);
    if (link.isSymbolicLink() || !link.isFile() || canonical !== resolve(path)) {
      throw preflightError("artifact recovery request must be an absolute regular link-free file");
    }
    if ((link.mode & 0o7777) !== 0o600) {
      throw preflightError("artifact recovery request mode must be exactly 0600");
    }
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    status = fstatSync(descriptor);
    if (
      link.dev !== status.dev ||
      link.ino !== status.ino ||
      !status.isFile() ||
      status.nlink !== 1
    ) {
      throw preflightError("artifact recovery request must be an absolute regular link-free file");
    }
    if (typeof process.getuid === "function" && status.uid !== process.getuid()) {
      throw preflightError("artifact recovery request must be owned by the current operator");
    }
    if ((status.mode & 0o7777) !== 0o600) {
      throw preflightError("artifact recovery request mode must be exactly 0600");
    }
    if (status.size < 2 || status.size > 256 * 1_024) {
      throw preflightError("artifact recovery request file has an invalid size");
    }
    bytes = readFileSync(descriptor);
    const after = fstatSync(descriptor);
    if (
      after.dev !== status.dev ||
      after.ino !== status.ino ||
      after.size !== status.size ||
      after.mtimeMs !== status.mtimeMs ||
      after.ctimeMs !== status.ctimeMs ||
      bytes.byteLength !== status.size
    ) {
      throw preflightError("artifact recovery request changed while it was being read");
    }
  } catch (error) {
    if (error instanceof DeployError) throw error;
    throw preflightError("artifact recovery request file is unavailable");
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
  let parsed: unknown;
  try {
    parsed = parseStrictJson(bytes, 256 * 1_024);
  } catch (error) {
    throw preflightError(
      "artifact recovery request is not strict JSON",
      error instanceof Error ? error.message : undefined,
    );
  }
  try {
    return await canonicalArtifactRecoveryRequest(parsed);
  } catch (error) {
    throw preflightError(
      "artifact recovery request is invalid",
      error instanceof Error ? error.message : undefined,
    );
  }
}

interface RpcTarget {
  readonly environment: "integration";
  readonly workerVersionId: string;
  readonly sourceCommit: string;
  readonly workerArtifactDigest: `sha256:${string}`;
}

async function exactRpcResult(
  value: unknown,
  action: "status" | "apply",
  target: RpcTarget,
  request: CanonicalArtifactRecoveryRequest,
): Promise<unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("artifact recovery RPC returned a non-object result");
  }
  const record = value as Record<string, unknown>;
  if (
    canonicalJson(Object.keys(record).sort()) !==
      canonicalJson(["kind", "action", "target", "result"].sort()) ||
    record.kind !== "takoserver.exact-failed-run-artifact-recovery-rpc-result@v1" ||
    record.action !== action ||
    canonicalJson(record.target) !== canonicalJson(target) ||
    typeof record.result !== "object" ||
    record.result === null ||
    Array.isArray(record.result)
  ) {
    throw new Error("artifact recovery RPC returned a mismatched exact result");
  }
  return action === "status"
    ? canonicalArtifactRecoveryReadback(record.result, request)
    : await canonicalArtifactRecoveryApplyResult(record.result, request);
}

function assertIntegration(
  invocation: ExactArtifactRecoveryInvocation,
  target: DeployTarget,
): void {
  if (invocation.environment !== "integration" || target.environment !== "integration") {
    throw preflightError("exact failed-run artifact recovery is integration-only");
  }
}

function assertSelectedLive(commit: string, live: LiveWorkerVersion): void {
  if (live.commit !== commit) {
    throw preflightError(
      "authoritative live Worker source commit does not match the selected recovery commit",
    );
  }
  if (!/^[0-9a-f]{64}$/u.test(live.bundleDigestHex)) {
    throw preflightError("authoritative live Worker artifact identity is invalid");
  }
}

function assertSameLive(
  expected: LiveWorkerVersion,
  actual: LiveWorkerVersion,
  boundary: string,
  phase: "preflight" | "verification",
): void {
  if (
    expected.history.deploymentId !== actual.history.deploymentId ||
    expected.history.versionId !== actual.history.versionId ||
    expected.history.previousVersionId !== actual.history.previousVersionId ||
    expected.commit !== actual.commit ||
    expected.bundleDigestHex !== actual.bundleDigestHex
  ) {
    throw (phase === "verification" ? verificationError : preflightError)(
      `authoritative live Worker identity changed ${boundary}`,
    );
  }
}

function exactReviewer(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9 ._@:/+-]{1,126}[A-Za-z0-9]$/u.test(value)) {
    throw preflightError("TAKOSERVER_INDEPENDENT_REVIEW is invalid");
  }
  return value;
}

function exactCloudflareToken(environment: Readonly<Record<string, string>>): string {
  const token = environment.CLOUDFLARE_API_TOKEN;
  if (!token || token.trim() !== token) throw preflightError("CLOUDFLARE_API_TOKEN is required");
  return token;
}

async function openTemporaryRecoveryCaller(input: {
  readonly target: DeployTarget;
  readonly tokenEnvironment: Readonly<Record<string, string>>;
}): Promise<RecoveryCallerSession> {
  const token = randomBytes(32).toString("base64url");
  const port = reserveLoopbackPort();
  const root = mkdtempSync(join(tmpdir(), "takoserver-artifact-recovery-caller-"));
  const configPath = join(root, "wrangler.json");
  try {
    chmodSync(root, 0o700);
    writeFileSync(
      configPath,
      `${JSON.stringify(
        {
          name: `takoserver-artifact-recovery-${randomBytes(8).toString("hex")}`,
          main: resolve(REPOSITORY, "src/entry-integration-exact-artifact-recovery-caller.ts"),
          compatibility_date: "2026-08-17",
          account_id: input.target.accountId,
          workers_dev: false,
          services: [
            {
              binding: "ARTIFACT_RECOVERY",
              service: input.target.workerName,
              entrypoint: "ExactFailedRunArtifactRecoveryEntrypoint",
            },
          ],
          vars: { TAKOSERVER_ARTIFACT_RECOVERY_CALLER_TOKEN: token },
        },
        null,
        2,
      )}\n`,
      { mode: 0o600, flag: "wx" },
    );
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw preflightError(
      "temporary artifact recovery caller state could not be created",
      error instanceof Error ? error.message : String(error),
    );
  }
  const child = (() => {
    try {
      return Bun.spawn(
        [
          WRANGLER,
          "dev",
          "--remote",
          "--config",
          configPath,
          "--ip",
          "127.0.0.1",
          "--port",
          String(port),
          "--no-show-interactive-dev-session",
        ],
        {
          cwd: REPOSITORY,
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
          env: sanitizedChildEnvironment(input.tokenEnvironment),
        },
      );
    } catch (error) {
      rmSync(root, { recursive: true, force: true });
      throw preflightError(
        "temporary artifact recovery caller could not be started",
        error instanceof Error ? error.message : String(error),
      );
    }
  })();
  const stdout = new Response(child.stdout).text();
  const stderr = new Response(child.stderr).text();
  const fetcher = (url: string, init?: RequestInit) => fetch(url, init);
  let stopped = false;
  const stopChild = async (): Promise<string> => {
    if (stopped) return "";
    stopped = true;
    try {
      try {
        child.kill("SIGTERM");
      } catch {
        // The process may already have exited; its exit promise remains the authority.
      }
      const exited = await waitForExit(child.exited, CHILD_EXIT_TIMEOUT_MILLISECONDS);
      if (!exited) {
        try {
          child.kill("SIGKILL");
        } catch {
          // A concurrent exit is equivalent to successful cleanup.
        }
        await child.exited.catch(() => undefined);
      }
      const [standardOutput, standardError] = await Promise.all([stdout, stderr]);
      return `${standardOutput}${standardError}`.trim();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };
  try {
    await awaitCallerReady(fetcher, port, token, child.exited);
  } catch (error) {
    const diagnostics = redactDiagnostics(await stopChild(), [
      token,
      input.tokenEnvironment.CLOUDFLARE_API_TOKEN ?? "",
    ]);
    throw preflightError(
      "temporary artifact recovery caller failed to become ready",
      diagnostics || (error instanceof Error ? error.message : String(error)),
    );
  }
  let closed = false;
  return {
    async call(value, timeoutMilliseconds) {
      if (closed) throw new Error("temporary artifact recovery caller is closed");
      return await callLoopbackArtifactRecovery({
        fetcher,
        port,
        token,
        value,
        timeoutMilliseconds,
      });
    },
    async close() {
      if (closed) return;
      closed = true;
      await stopChild();
    },
  };
}

function redactDiagnostics(value: string, secrets: readonly string[]): string {
  let redacted = value.slice(-16_384);
  for (const secret of secrets) {
    if (secret.length > 0) redacted = redacted.replaceAll(secret, "[redacted]");
  }
  return redacted;
}

async function waitForExit(exited: Promise<number>, timeoutMilliseconds: number): Promise<boolean> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      exited.then(
        () => true,
        () => true,
      ),
      new Promise<false>((resolveTimeout) => {
        timeout = setTimeout(() => resolveTimeout(false), timeoutMilliseconds);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

export async function callLoopbackArtifactRecovery(input: {
  readonly fetcher: (url: string, init?: RequestInit) => Promise<Response>;
  readonly port: number;
  readonly token: string;
  readonly value: unknown;
  readonly timeoutMilliseconds: number;
}): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), input.timeoutMilliseconds);
  try {
    const response = await input.fetcher(`http://127.0.0.1:${input.port}/invoke`, {
      method: "POST",
      redirect: "manual",
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${input.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(input.value),
    });
    if (response.status >= 300 && response.status < 400) {
      throw new Error("temporary artifact recovery caller returned a redirect");
    }
    const declared = response.headers.get("content-length");
    if (
      declared !== null &&
      (!/^[0-9]+$/u.test(declared) || Number(declared) > MAXIMUM_RESPONSE_BYTES)
    ) {
      throw new Error("temporary artifact recovery caller response is too large");
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > MAXIMUM_RESPONSE_BYTES) {
      throw new Error("temporary artifact recovery caller response is too large");
    }
    const body = new TextDecoder().decode(bytes);
    if (!response.ok) throw new Error(`temporary caller returned ${response.status}: ${body}`);
    if (response.headers.get("content-type")?.split(";", 1)[0] !== "application/json") {
      throw new Error("temporary artifact recovery caller returned a non-JSON response");
    }
    return parseStrictJson(bytes, MAXIMUM_RESPONSE_BYTES);
  } finally {
    clearTimeout(timeout);
  }
}

async function awaitCallerReady(
  fetcher: (url: string, init?: RequestInit) => Promise<Response>,
  port: number,
  token: string,
  exited: Promise<number>,
): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MILLISECONDS;
  while (Date.now() < deadline) {
    const controller = new AbortController();
    const attemptTimeout = setTimeout(
      () => controller.abort(),
      Math.min(500, Math.max(1, deadline - Date.now())),
    );
    const outcome = await Promise.race([
      exited.then((code) => ({ kind: "exit" as const, code })),
      fetcher(`http://127.0.0.1:${port}/__ready`, {
        redirect: "manual",
        signal: controller.signal,
        headers: { authorization: `Bearer ${token}` },
      })
        .then((response) => ({ kind: "response" as const, response }))
        .catch(() => ({ kind: "pending" as const })),
    ]).finally(() => clearTimeout(attemptTimeout));
    if (outcome.kind === "exit") throw new Error(`wrangler dev exited ${outcome.code}`);
    if (outcome.kind === "response") {
      if (outcome.response.status >= 300 && outcome.response.status < 400) {
        throw new Error("temporary artifact recovery caller readiness returned a redirect");
      }
      if (outcome.response.status === 204) return;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error("temporary caller readiness timed out");
}

function reserveLoopbackPort(): number {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null) });
  const port = server.port;
  server.stop(true);
  if (port === undefined) throw new Error("failed to reserve a loopback port");
  return port;
}
