import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { isPublicHostIdentity, type PublicHostIdentity } from "../../src/public-host-identity.ts";
import {
  derivePublicFormImplementationIdentity,
  publicFormCapabilityManifest,
} from "../../src/public-worker-implementation.ts";
import { parseStrictJson } from "../../src/strict-json.ts";
import { CloudflareState } from "./cloudflare-state.ts";
import { type DeployPhase, mutationError, preflightError, verificationError } from "./errors.ts";
import { assertPublicFormCapabilityTarget } from "./form-authority-capability.ts";
import {
  type CommandResult,
  cloudflareChildEnvironment,
  REPOSITORY,
  requireEnvironment,
  runCommand,
  wranglerCommand,
} from "./process.ts";
import { type DeployEnvironment, qualifySource } from "./qualification.ts";
import type { DeployTarget } from "./target.ts";
import { prepareWorkerArtifact } from "./worker-artifact.ts";
import { inspectLiveWorkerVersion } from "./worker-live.ts";
import {
  assertExactSecretInventory,
  assertExactVersionBindingClosure,
  parseWorkerDeploymentHistory,
  type WorkerDeploymentHistory,
} from "./worker-state.ts";

const PROBE_PATH = "/v1/public-host-identity";
const MAX_PROBE_RESPONSE_BYTES = 16 * 1_024;

export interface FormAuthorityIdentityProbeInvocation {
  readonly surface: "takoserver-form-authority-identity-probe";
  readonly action: "status" | "apply";
  readonly environment: DeployEnvironment;
  readonly commit: string;
}

export type FormAuthorityIdentityProbeProcess = (
  command: readonly string[],
  options?: { readonly env?: Readonly<Record<string, string>>; readonly input?: string },
) => Promise<CommandResult>;

export interface FormAuthorityIdentityProbeState {
  workerScripts(): Promise<readonly string[]>;
  workerDeployments(workerName: string): Promise<readonly unknown[]>;
  workerVersion(workerName: string, versionId: string): Promise<unknown>;
  workerSecrets(workerName: string): Promise<readonly unknown[]>;
  workerDomains(): Promise<readonly { readonly hostname: string; readonly service: string }[]>;
  workerSubdomain(workerName: string): Promise<{
    readonly enabled: boolean;
    readonly previewsEnabled: boolean;
  }>;
  workerRoutes(): Promise<
    readonly {
      readonly zoneId: string;
      readonly id: string;
      readonly pattern: string;
      readonly script: string | null;
    }[]
  >;
}

export interface FormAuthorityIdentityProbeOptions {
  readonly run?: FormAuthorityIdentityProbeProcess;
  readonly state?: FormAuthorityIdentityProbeState;
  readonly fetcher?: (input: string, init?: RequestInit) => Promise<Response>;
  readonly outputDirectory?: string;
  readonly cloudflareEnvironment?: Readonly<Record<string, string>>;
  readonly review?: string;
}

interface ProbeInspection {
  readonly history: WorkerDeploymentHistory;
  readonly commit: string;
  readonly artifactDigest: `sha256:${string}`;
}

export interface PublicIdentityProbeExpectation {
  readonly history: WorkerDeploymentHistory;
  readonly commit: string;
  readonly workerArtifactDigest: `sha256:${string}`;
}

export interface PublicIdentityProbeReadback {
  readonly ready: boolean;
  readonly identity: PublicHostIdentity | null;
}

/** Owns the permanent minimal HTTP-to-PublicHostIdentity RPC bridge. */
export async function runFormAuthorityIdentityProbe(
  invocation: FormAuthorityIdentityProbeInvocation,
  target: DeployTarget,
  options: FormAuthorityIdentityProbeOptions = {},
): Promise<Record<string, unknown>> {
  assertPublicFormCapabilityTarget(target);
  if (target.environment !== invocation.environment) {
    throw preflightError("Form authority identity probe invocation and target differ");
  }
  const selected = requireProbeTarget(target);
  const run = options.run ?? runCommand;
  const environment =
    options.cloudflareEnvironment ??
    (options.state !== undefined && invocation.action === "status"
      ? {}
      : cloudflareChildEnvironment());
  const state =
    options.state ??
    new CloudflareState({ accountId: target.accountId, token: exactToken(environment) });
  const fetcher = options.fetcher ?? fetch;
  const publicBefore = await inspectPublic("preflight", target, state);
  const before = await inspectProbe("preflight", target, state);
  const readbackBefore =
    before === null
      ? { ready: false, identity: null }
      : await readPublicHostIdentityProbe(target, publicBefore, fetcher);

  if (invocation.action === "status") {
    return probeResult({
      kind: "takoserver.form-authority-identity-probe-status@v1",
      invocation,
      selected,
      publicWorker: publicBefore,
      probe: before,
      readback: readbackBefore,
      ready:
        before?.commit === invocation.commit &&
        publicBefore.commit === invocation.commit &&
        readbackBefore.ready,
    });
  }

  const reviewer = exactReviewer(
    options.review ?? requireEnvironment("TAKOSERVER_INDEPENDENT_REVIEW"),
  );
  const source = await qualifySource({
    environment: invocation.environment,
    commit: invocation.commit,
    run,
  });
  if (publicBefore.commit !== source.commit) {
    throw preflightError("served public Worker differs from identity probe source commit");
  }
  await checked(run, "scoped identity probe owner gate `bun run check`", ["bun", "run", "check"]);

  const temporary = options.outputDirectory === undefined;
  const root =
    options.outputDirectory ?? mkdtempSync(join(tmpdir(), "takoserver-form-identity-probe-"));
  mkdirSync(root, { recursive: true, mode: 0o700 });
  try {
    const publicProof = await prepareWorkerArtifact({
      root: join(root, "public-worker-proof"),
      target,
      commit: source.commit,
      run,
    });
    if (`sha256:${publicProof.bundleDigestHex}` !== publicBefore.workerArtifactDigest) {
      throw preflightError(
        "served public Worker artifact differs from identity probe source build",
      );
    }
    const publicArtifact = publicProof.seal();
    publicArtifact.assertUnchanged();
    const prepared = await prepareWorkerArtifact({
      root,
      target,
      commit: source.commit,
      run,
      main: resolve(REPOSITORY, "src/entry-form-authority-identity-probe.ts"),
      writeConfig: ({ path, main }) => writeProbeConfig({ path, main, target }),
    });
    const artifactDigest = `sha256:${prepared.bundleDigestHex}` as const;
    const artifact = prepared.seal();
    artifact.assertUnchanged();

    const publicLast = await inspectPublic("preflight", target, state);
    assertSamePublic("preflight", publicBefore, publicLast);
    const last = await inspectProbe("preflight", target, state);
    assertSameProbe("preflight", before, last);
    const upload = await run(
      wranglerCommand([
        "deploy",
        prepared.bundlePath,
        "--no-bundle",
        "--config",
        prepared.configPath,
        "--strict",
        "--message",
        probeMessage(source.commit, artifactDigest),
      ]),
      { env: environment },
    );
    if (upload.exitCode !== 0) {
      throw mutationError(
        "identity probe upload acknowledgement is indeterminate; do not retry before --status",
        `${upload.stdout}${upload.stderr}`.trim(),
      );
    }

    const publicAfter = await inspectPublic("verification", target, state);
    assertSamePublic("verification", publicBefore, publicAfter);
    const after = await inspectProbe("verification", target, state);
    if (
      after === null ||
      after.history.versionId === before?.history.versionId ||
      (before !== null && after.history.previousVersionId !== before.history.versionId) ||
      after.commit !== source.commit ||
      after.artifactDigest !== artifactDigest
    ) {
      throw verificationError(
        "identity probe authoritative history does not identify the uploaded successor",
      );
    }
    const readback = await readPublicHostIdentityProbe(target, publicAfter, fetcher);
    if (!readback.ready) {
      throw verificationError("identity probe did not return the exact live public RPC identity");
    }
    return {
      ...probeResult({
        kind: "takoserver.form-authority-identity-probe-apply@v1",
        invocation,
        selected,
        publicWorker: publicAfter,
        probe: after,
        readback,
        ready: true,
      }),
      dirty: source.dirty,
      remoteRef: source.remoteRef,
      reviewer,
      artifactBytes: artifact.bytes,
      artifactFiles: artifact.files,
      previousVersionId: before?.history.versionId ?? null,
      rollback: before
        ? `wrangler versions deploy ${before.history.versionId}@100% --yes --name ${selected.workerName}`
        : "forward repair only: no previous identity probe version exists",
    };
  } finally {
    if (temporary) rmSync(root, { recursive: true, force: true });
  }
}

export function writeProbeConfig(input: {
  readonly path: string;
  readonly main: string;
  readonly target: DeployTarget;
}): string {
  const selected = requireProbeTarget(input.target);
  const configuration = {
    account_id: input.target.accountId,
    name: selected.workerName,
    main: input.main,
    compatibility_date: "2026-08-17",
    compatibility_flags: ["nodejs_compat"],
    workers_dev: true,
    preview_urls: false,
    observability: { enabled: true },
    vars: { TAKOSERVER_FORM_AUTHORITY_HOST_ID: selected.hostId },
    services: [
      {
        binding: "PUBLIC_HOST_IDENTITY",
        service: input.target.workerName,
        entrypoint: "PublicHostIdentityEntrypoint",
      },
    ],
  };
  writeFileSync(input.path, `${JSON.stringify(configuration, null, 2)}\n`, { mode: 0o600 });
  return input.path;
}

async function inspectPublic(
  phase: DeployPhase,
  target: DeployTarget,
  state: FormAuthorityIdentityProbeState,
): Promise<PublicIdentityProbeExpectation> {
  const live = await inspectLiveWorkerVersion(phase, target, state, {
    authorityProfile: { kind: "provenance-bound-jit" },
  });
  return {
    history: live.history,
    commit: live.commit,
    workerArtifactDigest: `sha256:${live.bundleDigestHex}`,
  };
}

async function inspectProbe(
  phase: DeployPhase,
  target: DeployTarget,
  state: FormAuthorityIdentityProbeState,
): Promise<ProbeInspection | null> {
  const selected = requireProbeTarget(target);
  const scripts = await state.workerScripts();
  if (scripts.length !== new Set(scripts).size) {
    throw phaseError(phase, "identity probe script inventory contains duplicates");
  }
  const domains = await state.workerDomains();
  if (domains.some(({ service }) => service === selected.workerName)) {
    throw phaseError(phase, "identity probe unexpectedly owns a custom domain");
  }
  const routes = (await state.workerRoutes()).filter(
    ({ script }) => script === selected.workerName,
  );
  if (routes.length > 0) throw phaseError(phase, "identity probe unexpectedly owns a zone route");
  if (!scripts.includes(selected.workerName)) return null;
  const history = parseWorkerDeploymentHistory(
    await state.workerDeployments(selected.workerName),
    phase,
  );
  if (history === null) throw phaseError(phase, "identity probe has no served deployment");
  const version = await state.workerVersion(selected.workerName, history.versionId);
  const identity = probeVersionIdentity(phase, version);
  assertExactVersionBindingClosure(phase, history.versionId, version, {
    TAKOSERVER_FORM_AUTHORITY_HOST_ID: {
      type: "plain_text",
      fields: { text: selected.hostId },
    },
    PUBLIC_HOST_IDENTITY: {
      type: "service",
      fields: { service: target.workerName, entrypoint: "PublicHostIdentityEntrypoint" },
    },
  });
  assertExactSecretInventory(await state.workerSecrets(selected.workerName), [], phase);
  const subdomain = await state.workerSubdomain(selected.workerName);
  if (!subdomain.enabled || subdomain.previewsEnabled) {
    throw phaseError(phase, "identity probe workers.dev topology is not exact");
  }
  return { history, ...identity };
}

export async function readPublicHostIdentityProbe(
  target: DeployTarget,
  publicWorker: PublicIdentityProbeExpectation,
  fetcher: (input: string, init?: RequestInit) => Promise<Response>,
): Promise<PublicIdentityProbeReadback> {
  const selected = requireProbeTarget(target);
  try {
    const response = await fetcher(`${selected.origin}${PROBE_PATH}`, {
      method: "GET",
      headers: { accept: "application/json", "cache-control": "no-store" },
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
    if (
      response.status !== 200 ||
      !response.headers.get("content-type")?.toLowerCase().startsWith("application/json")
    ) {
      return { ready: false, identity: null };
    }
    const bytes = await boundedProbeResponse(response);
    const value = parseStrictJson(bytes, MAX_PROBE_RESPONSE_BYTES);
    if (!isPublicHostIdentity(value)) return { ready: false, identity: null };
    const expected = await derivePublicFormImplementationIdentity({
      implementationPayloadDigest: value.implementationPayloadDigest,
      capabilities: publicFormCapabilityManifest(),
    });
    if (
      value.hostId !== selected.hostId ||
      value.workerVersionId !== publicWorker.history.versionId ||
      value.workerArtifactDigest !== publicWorker.workerArtifactDigest ||
      value.capabilityDigest !== expected.capabilityDigest ||
      value.implementationDigest !== expected.implementationDigest
    ) {
      return { ready: false, identity: null };
    }
    return { ready: true, identity: value };
  } catch {
    return { ready: false, identity: null };
  }
}

async function boundedProbeResponse(response: Response): Promise<Uint8Array> {
  const declared = response.headers.get("content-length");
  if (declared && (!/^\d+$/u.test(declared) || Number(declared) > MAX_PROBE_RESPONSE_BYTES)) {
    throw new TypeError("identity probe response is too large");
  }
  if (!response.body) throw new TypeError("identity probe response has no body");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_PROBE_RESPONSE_BYTES) {
        await reader.cancel();
        throw new TypeError("identity probe response is too large");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function probeResult(input: {
  readonly kind:
    | "takoserver.form-authority-identity-probe-status@v1"
    | "takoserver.form-authority-identity-probe-apply@v1";
  readonly invocation: FormAuthorityIdentityProbeInvocation;
  readonly selected: { readonly workerName: string; readonly origin: string };
  readonly publicWorker: PublicIdentityProbeExpectation;
  readonly probe: ProbeInspection | null;
  readonly readback: PublicIdentityProbeReadback;
  readonly ready: boolean;
}): Record<string, unknown> {
  return {
    kind: input.kind,
    surface: input.invocation.surface,
    environment: input.invocation.environment,
    workerName: input.selected.workerName,
    origin: input.selected.origin,
    selectedCommit: input.invocation.commit,
    deployedCommit: input.probe?.commit ?? null,
    commitMatches: input.probe?.commit === input.invocation.commit,
    deploymentId: input.probe?.history.deploymentId ?? null,
    versionId: input.probe?.history.versionId ?? null,
    previousVersionId: input.probe?.history.previousVersionId ?? null,
    probeArtifactDigest: input.probe?.artifactDigest ?? null,
    publicWorkerCommit: input.publicWorker.commit,
    publicWorkerVersionId: input.publicWorker.history.versionId,
    workerArtifactDigest: input.publicWorker.workerArtifactDigest,
    publicIdentityRpcReady: input.readback.ready,
    implementationPayloadDigest: input.readback.identity?.implementationPayloadDigest ?? null,
    capabilityDigest: input.readback.identity?.capabilityDigest ?? null,
    implementationDigest: input.readback.identity?.implementationDigest ?? null,
    ready: input.ready,
  };
}

function requireProbeTarget(target: DeployTarget): {
  readonly workerName: string;
  readonly origin: string;
  readonly hostId: string;
} {
  const authority = target.formAuthority;
  if (!authority) throw preflightError("deploy target has no Form authority identity probe");
  return {
    workerName: authority.identityProbeWorkerName,
    origin: authority.identityProbeOrigin,
    hostId: authority.hostId,
  };
}

function probeVersionIdentity(
  phase: DeployPhase,
  value: unknown,
): { readonly commit: string; readonly artifactDigest: `sha256:${string}` } {
  if (!isRecord(value) || !isRecord(value.annotations)) {
    throw phaseError(phase, "identity probe has no canonical annotations");
  }
  const message = value.annotations["workers/message"];
  const match =
    typeof message === "string"
      ? /^form-authority-identity-probe:([0-9a-f]{40}):(sha256:[0-9a-f]{64})$/u.exec(message)
      : null;
  if (!match?.[1] || !match[2]) {
    throw phaseError(phase, "identity probe version identity is missing or invalid");
  }
  return { commit: match[1], artifactDigest: match[2] as `sha256:${string}` };
}

function probeMessage(commit: string, artifactDigest: `sha256:${string}`): string {
  return `form-authority-identity-probe:${commit}:${artifactDigest}`;
}

function assertSamePublic(
  phase: DeployPhase,
  before: PublicIdentityProbeExpectation,
  after: PublicIdentityProbeExpectation,
): void {
  if (
    before.history.deploymentId !== after.history.deploymentId ||
    before.history.versionId !== after.history.versionId ||
    before.history.previousVersionId !== after.history.previousVersionId ||
    before.commit !== after.commit ||
    before.workerArtifactDigest !== after.workerArtifactDigest
  ) {
    throw phaseError(phase, "public Worker changed during identity probe qualification");
  }
}

function assertSameProbe(
  phase: DeployPhase,
  before: ProbeInspection | null,
  after: ProbeInspection | null,
): void {
  if (
    (before === null) !== (after === null) ||
    (before !== null &&
      after !== null &&
      (before.history.deploymentId !== after.history.deploymentId ||
        before.history.versionId !== after.history.versionId ||
        before.commit !== after.commit ||
        before.artifactDigest !== after.artifactDigest))
  ) {
    throw phaseError(phase, "identity probe changed during qualification");
  }
}

async function checked(
  run: FormAuthorityIdentityProbeProcess,
  description: string,
  command: readonly string[],
): Promise<void> {
  const result = await run(command);
  if (result.exitCode !== 0) {
    throw preflightError(
      `${description} failed (exit ${result.exitCode})`,
      `${result.stdout}${result.stderr}`.trim(),
    );
  }
}

function exactReviewer(value: string): string {
  if (value.trim() !== value || value.length < 1 || value.length > 256 || value.includes("\n")) {
    throw preflightError("TAKOSERVER_INDEPENDENT_REVIEW must name one reviewer");
  }
  return value;
}

function exactToken(environment: Readonly<Record<string, string>>): string {
  const token = environment.CLOUDFLARE_API_TOKEN;
  if (!token) throw preflightError("CLOUDFLARE_API_TOKEN is required");
  return token;
}

function phaseError(phase: DeployPhase, message: string): Error {
  return phase === "verification" ? verificationError(message) : preflightError(message);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
