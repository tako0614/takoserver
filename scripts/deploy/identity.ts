import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { signOperatorAssertion } from "../../src/operator-key.ts";
import { CloudflareState } from "./cloudflare-state.ts";
import {
  DeployError,
  type DeployPhase,
  mutationError,
  preflightError,
  verificationError,
} from "./errors.ts";
import {
  type CommandResult,
  cloudflareChildEnvironment,
  requireEnvironment,
  runCommand,
  wranglerCommand,
} from "./process.ts";
import { type DeployEnvironment, qualifySource } from "./qualification.ts";
import { expectedWorkerSecrets } from "./realized-config.ts";
import type { DeployTarget } from "./target.ts";
import { prepareWorkerArtifact } from "./worker-artifact.ts";
import {
  assertDomainClosure,
  type LiveWorkerVersion,
  type WorkerState,
  workerVersionIdentity,
} from "./worker-live.ts";
import {
  assertExactSecretInventory,
  assertExactVersionBindingClosure,
  expectedExactBindingClosure,
  parseWorkerDeploymentHistory,
} from "./worker-state.ts";

export interface OperatorIdentityInvocation {
  readonly surface: "takoserver-integration-operator-identity";
  readonly action: "status" | "apply";
  readonly environment: DeployEnvironment;
  readonly commit: string;
}

export type OperatorIdentityProcess = (
  command: readonly string[],
  options?: { readonly env?: Readonly<Record<string, string>>; readonly input?: string },
) => Promise<CommandResult>;

export interface OperatorIdentityOptions {
  readonly run?: OperatorIdentityProcess;
  readonly state?: WorkerState;
  readonly privateJwkPath?: string;
  readonly review?: string;
  readonly outputDirectory?: string;
  readonly cloudflareEnvironment?: Readonly<Record<string, string>>;
  readonly fetcher?: (input: string, init?: RequestInit) => Promise<Response>;
  readonly now?: () => Date;
}

interface IdentityInspection extends LiveWorkerVersion {
  readonly configured: boolean;
  readonly version: unknown;
}

export interface PrivateKeyInput {
  readonly jwk: JsonWebKey & { readonly x: string; readonly d: string };
}

const PRIVATE_JWK_KEYS = ["crv", "d", "ext", "key_ops", "kty", "x"] as const;
const BASE64URL_32 = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/u;

/** Integration-only operator identity configuration transition. */
export async function runOperatorIdentity(
  invocation: OperatorIdentityInvocation,
  target: DeployTarget,
  options: OperatorIdentityOptions = {},
): Promise<Record<string, unknown>> {
  assertIntegrationInvocation(invocation, target);
  const publicJwk = target.operatorIdentity?.publicJwk;
  if (!publicJwk) {
    throw preflightError("operator identity surface requires target `operatorIdentity.publicJwk`");
  }
  const canonicalPublicJwk = JSON.stringify(publicJwk);
  const desiredPublicJwkDigest = sha256(canonicalPublicJwk);
  const environment =
    options.cloudflareEnvironment ??
    (options.state !== undefined && invocation.action === "status"
      ? {}
      : cloudflareChildEnvironment());
  const state =
    options.state ??
    new CloudflareState({
      accountId: target.accountId,
      token: exactCloudflareToken(environment),
    });
  const live = await inspectIdentity("preflight", target, state);

  if (invocation.action === "status") {
    return {
      kind: "takoserver.integration-operator-identity-status@v2",
      surface: invocation.surface,
      environment: invocation.environment,
      selectedCommit: invocation.commit,
      deployedCommit: live.commit,
      versionId: live.history.versionId,
      desiredPublicJwkDigest,
      configuredPublicJwkDigest: live.configured ? desiredPublicJwkDigest : null,
      configured: live.configured,
      ready: live.commit === invocation.commit && !live.configured,
    };
  }

  if (live.configured) {
    throw preflightError("operator identity is already configured; use --status");
  }
  const run = options.run ?? runCommand;
  const source = await qualifySource({
    environment: "integration",
    commit: invocation.commit,
    run,
  });
  if (live.commit !== source.commit) {
    throw preflightError("operator identity commit must equal the currently served Worker commit");
  }
  const reviewer = exactReviewer(
    options.review ?? requireEnvironment("TAKOSERVER_INDEPENDENT_REVIEW"),
  );
  const privateInput = readPrivateJwk(
    options.privateJwkPath ?? requireEnvironment("TAKOSERVER_OPERATOR_PRIVATE_JWK_PATH"),
  );
  await provePrivateMatchesPublic(privateInput, publicJwk);
  const gate = await run(["bun", "run", "check"]);
  if (gate.exitCode !== 0) {
    throw preflightError(
      `scoped owner gate \`bun run check\` failed (exit ${gate.exitCode})`,
      `${gate.stdout}${gate.stderr}`.trim(),
    );
  }

  const temporary = options.outputDirectory === undefined;
  const root = options.outputDirectory ?? mkdtempSync(join(tmpdir(), "takoserver-identity-"));
  mkdirSync(root, { recursive: true, mode: 0o700 });
  try {
    const prepared = await prepareWorkerArtifact({
      root,
      target,
      commit: source.commit,
      signingKeyId: target.signing.currentKeyId,
      run,
    });
    if (prepared.bundleDigestHex !== live.bundleDigestHex) {
      throw preflightError(
        "operator identity cutover refuses to carry different Worker code bytes",
        `served=sha256:${live.bundleDigestHex} built=sha256:${prepared.bundleDigestHex}`,
      );
    }
    const artifact = prepared.seal();
    artifact.assertUnchanged();

    // Close the build/upload race. A Version advance after qualification is
    // unrelated authority, even when its code annotation happens to match.
    const last = await inspectIdentity("preflight", target, state);
    assertSameUnconfiguredVersion(live, last);

    const upload = await run(
      wranglerCommand([
        "deploy",
        prepared.bundlePath,
        "--no-bundle",
        "--config",
        prepared.configPath,
        "--strict",
        "--message",
        `takoserver-worker:${source.commit}:${prepared.bundleDigestHex}`,
      ]),
      { env: environment },
    );
    if (upload.exitCode !== 0) {
      throw mutationError(
        "operator identity upload acknowledgement is indeterminate; do not retry before --status",
        redactDiagnostics(`${upload.stdout}${upload.stderr}`.trim(), [
          environment.CLOUDFLARE_API_TOKEN,
        ]),
      );
    }

    const after = await inspectIdentity("verification", target, state);
    assertOnlyOperatorIdentityAdvance(live, after);
    const proof = await proveOperatorSession(
      target.publicOrigin,
      privateInput,
      options.now?.() ?? new Date(),
      options.fetcher ?? ((input, init) => fetch(input, init)),
    );
    return {
      kind: "takoserver.integration-operator-identity-apply@v2",
      surface: invocation.surface,
      environment: invocation.environment,
      commit: source.commit,
      dirty: source.dirty,
      remoteRef: source.remoteRef,
      reviewer,
      publicJwkDigest: desiredPublicJwkDigest,
      artifactDigest: artifact.digest,
      bundleDigest: `sha256:${prepared.bundleDigestHex}`,
      previousVersionId: live.history.versionId,
      versionId: after.history.versionId,
      exactConfigDiff: {
        added: [{ name: "OPERATOR_IDENTITY_PUBLIC_JWK", valueDigest: desiredPublicJwkDigest }],
        changed: [],
        removed: [],
      },
      proof,
      reversal:
        "revoke every session and API key issued through this identity before a separately reviewed identity removal",
    };
  } finally {
    if (temporary) rmSync(root, { recursive: true, force: true });
  }
}

async function inspectIdentity(
  phase: DeployPhase,
  target: DeployTarget,
  state: WorkerState,
): Promise<IdentityInspection> {
  try {
    return await inspectIdentityState(phase, target, state);
  } catch (error) {
    if (phase === "verification" && error instanceof DeployError && error.phase !== phase) {
      throw verificationError(error.message, error.detail);
    }
    throw error;
  }
}

async function inspectIdentityState(
  phase: DeployPhase,
  target: DeployTarget,
  state: WorkerState,
): Promise<IdentityInspection> {
  const history = parseWorkerDeploymentHistory(await state.workerDeployments(target.workerName));
  if (history === null) {
    throw phase === "verification"
      ? verificationError("Worker has no authoritative current deployment")
      : preflightError("Worker has no authoritative current deployment");
  }
  const version = await state.workerVersion(target.workerName, history.versionId);
  const identity = workerVersionIdentity(phase, version);
  const authorityProfile =
    target.integrationE2eCredentialAuthority === undefined
      ? undefined
      : {
          kind: "provenance-bound-jit" as const,
          provenance: {
            sourceCommit: identity.commit,
            artifactDigest: `sha256:${identity.bundleDigestHex}` as const,
          },
        };
  const desired = expectedExactBindingClosure(target, {
    signingKeyId: target.signing.currentKeyId,
    ...(authorityProfile === undefined ? {} : { authorityProfile }),
  });
  let configured = true;
  try {
    assertExactVersionBindingClosure(phase, history.versionId, version, desired);
  } catch {
    configured = false;
    assertExactVersionBindingClosure(
      phase,
      history.versionId,
      version,
      expectedExactBindingClosure(withoutOperatorIdentity(target), {
        signingKeyId: target.signing.currentKeyId,
        ...(authorityProfile === undefined ? {} : { authorityProfile }),
      }),
    );
  }
  assertExactSecretInventory(
    await state.workerSecrets(target.workerName),
    expectedWorkerSecrets(target),
    phase,
  );
  assertDomainClosure(phase, target, await state.workerDomains());
  return { history, ...identity, configured, version };
}

function withoutOperatorIdentity(target: DeployTarget): DeployTarget {
  const { operatorIdentity: _operatorIdentity, ...withoutIdentity } = target;
  return withoutIdentity;
}

function assertIntegrationInvocation(
  invocation: OperatorIdentityInvocation,
  target: DeployTarget,
): void {
  if (invocation.environment !== "integration" || target.environment !== "integration") {
    throw preflightError("operator identity surface is integration-only");
  }
  if (target.environment !== invocation.environment) {
    throw preflightError("operator identity invocation and target environments differ");
  }
}

function exactCloudflareToken(environment: Readonly<Record<string, string>>): string {
  const value = environment.CLOUDFLARE_API_TOKEN;
  if (!value) throw preflightError("CLOUDFLARE_API_TOKEN is required");
  return value;
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function readPrivateJwk(path: string): PrivateKeyInput {
  let descriptor: number | null = null;
  let raw: string;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const status = fstatSync(descriptor);
    if (
      !status.isFile() ||
      status.nlink !== 1 ||
      (typeof process.getuid === "function" && status.uid !== process.getuid()) ||
      (status.mode & 0o777) !== 0o600
    ) {
      throw new Error("unsafe");
    }
    raw = readFileSync(descriptor, "utf8");
  } catch {
    throw preflightError("operator private JWK must be an owned 0600 link-free regular file");
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
  if (raw.length === 0 || raw.length > 16_384) {
    throw preflightError("operator private JWK must be an owned 0600 link-free regular file");
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw preflightError("operator private JWK is not valid JSON");
  }
  if (
    !isRecord(value) ||
    JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...PRIVATE_JWK_KEYS].sort()) ||
    value.kty !== "OKP" ||
    value.crv !== "Ed25519" ||
    value.ext !== true ||
    !Array.isArray(value.key_ops) ||
    JSON.stringify(value.key_ops) !== JSON.stringify(["sign"]) ||
    typeof value.x !== "string" ||
    typeof value.d !== "string" ||
    !BASE64URL_32.test(value.x) ||
    !BASE64URL_32.test(value.d)
  ) {
    throw preflightError("operator private JWK must be one exact Ed25519 signing key");
  }
  return {
    jwk: value as unknown as JsonWebKey & { readonly x: string; readonly d: string },
  };
}

export async function provePrivateMatchesPublic(
  input: PrivateKeyInput,
  publicJwk: { readonly kty: "OKP"; readonly crv: "Ed25519"; readonly x: string },
): Promise<void> {
  if (input.jwk.x !== publicJwk.x) {
    throw preflightError("operator private JWK does not match target public JWK");
  }
  try {
    const privateKey = await crypto.subtle.importKey("jwk", input.jwk, { name: "Ed25519" }, false, [
      "sign",
    ]);
    const publicKey = await crypto.subtle.importKey("jwk", publicJwk, { name: "Ed25519" }, false, [
      "verify",
    ]);
    const message = new TextEncoder().encode("takoserver.deploy.operator-identity-proof@v1");
    const signature = await crypto.subtle.sign("Ed25519", privateKey, message);
    if (!(await crypto.subtle.verify("Ed25519", publicKey, signature, message))) {
      throw new Error("key pair proof failed");
    }
  } catch {
    throw preflightError("operator private JWK does not match target public JWK");
  }
}

function exactReviewer(value: string): string {
  if (value.trim() !== value || value.length < 1 || value.length > 256 || value.includes("\n")) {
    throw preflightError("TAKOSERVER_INDEPENDENT_REVIEW must name one reviewer");
  }
  return value;
}

function assertSameUnconfiguredVersion(before: IdentityInspection, last: IdentityInspection): void {
  if (
    before.configured ||
    last.configured ||
    last.history.deploymentId !== before.history.deploymentId ||
    last.history.versionId !== before.history.versionId ||
    last.history.previousVersionId !== before.history.previousVersionId ||
    last.commit !== before.commit ||
    last.bundleDigestHex !== before.bundleDigestHex ||
    canonicalNonIdentityResources(last.version) !== canonicalNonIdentityResources(before.version)
  ) {
    throw preflightError("Worker changed during operator identity qualification; upload refused");
  }
}

function assertOnlyOperatorIdentityAdvance(
  before: IdentityInspection,
  after: IdentityInspection,
): void {
  if (
    before.configured ||
    !after.configured ||
    after.history.versionId === before.history.versionId ||
    after.history.previousVersionId !== before.history.versionId ||
    after.commit !== before.commit ||
    after.bundleDigestHex !== before.bundleDigestHex ||
    canonicalNonIdentityResources(after.version) !== canonicalNonIdentityResources(before.version)
  ) {
    throw verificationError(
      "operator identity cutover changed more than the exact OPERATOR_IDENTITY_PUBLIC_JWK variable",
    );
  }
}

function canonicalNonIdentityResources(version: unknown): string {
  if (
    !isRecord(version) ||
    !isRecord(version.resources) ||
    !Array.isArray(version.resources.bindings)
  ) {
    throw preflightError("Worker Version has no canonical resource inventory");
  }
  const bindings = version.resources.bindings.filter((binding) => {
    if (!isRecord(binding)) throw preflightError("Worker Version has a malformed binding");
    const name = typeof binding.name === "string" ? binding.name : binding.binding;
    return name !== "OPERATOR_IDENTITY_PUBLIC_JWK";
  });
  return canonicalJson({ ...version.resources, bindings });
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    const entries = value.map((entry) => canonicalJson(entry));
    return `[${entries.join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

async function proveOperatorSession(
  origin: string,
  privateInput: PrivateKeyInput,
  now: Date,
  fetcher: (input: string, init?: RequestInit) => Promise<Response>,
): Promise<{
  readonly sessionStatus: 200;
  readonly meStatus: 200;
  readonly revokeStatus: number | "transport-error";
  readonly replayStatus: 401;
  readonly sessionRevoked: true;
  readonly assertionRedacted: true;
  readonly sessionRedacted: true;
}> {
  const nowSeconds = Math.floor(now.getTime() / 1_000);
  if (!Number.isSafeInteger(nowSeconds)) {
    throw verificationError("operator identity proof clock is invalid");
  }
  let assertion: string;
  try {
    assertion = await signOperatorAssertion({
      privateJwk: JSON.stringify(privateInput.jwk),
      claims: {
        purpose: "sign-in",
        provider: "google",
        subject: "task-0037-integration-operator",
        email: "task-0037-integration-operator@localhost",
        displayName: "TASK-0037 Integration Operator",
      },
      nowSeconds,
      lifetimeSeconds: 60,
    });
  } catch {
    throw verificationError("operator identity assertion signing failed; private key redacted");
  }
  let sessionResponse: Response;
  try {
    sessionResponse = await fetcher(`${origin}/v1/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json", "cache-control": "no-store" },
      body: JSON.stringify({
        provider: "google",
        method: "operator-assertion",
        assertion,
      }),
      redirect: "error",
    });
  } catch {
    throw verificationError(
      "operator identity session proof transport failed; credentials redacted",
    );
  }
  const sessionBody = (await sessionResponse.json().catch(() => null)) as unknown;
  if (sessionResponse.status !== 200 || !isRecord(sessionBody)) {
    throw verificationError(
      "operator identity session proof returned an invalid redacted response",
      `status=${sessionResponse.status}`,
    );
  }
  const sessionToken = sessionBody.sessionToken;
  if (typeof sessionToken !== "string" || sessionToken.length < 1 || sessionToken.length > 16_384) {
    throw verificationError(
      "operator identity session proof returned no usable redacted session",
      `status=${sessionResponse.status}`,
    );
  }
  let proofFailure: Error | null = null;
  const principal = sessionBody.principal;
  if (!exactKeys(sessionBody, ["principal", "sessionToken"]) || !validProofPrincipal(principal)) {
    proofFailure = verificationError(
      "operator identity session proof returned an invalid redacted principal",
      `status=${sessionResponse.status}`,
    );
  }
  let meResponse: Response | null = null;
  try {
    meResponse = await fetcher(`${origin}/v1/me`, {
      method: "GET",
      headers: { authorization: `Bearer ${sessionToken}`, "cache-control": "no-store" },
      redirect: "error",
    });
  } catch {
    proofFailure ??= verificationError(
      "operator identity /v1/me proof transport failed; credentials redacted",
    );
  }
  if (meResponse !== null) {
    const meBody = (await meResponse.json().catch(() => null)) as unknown;
    if (
      meResponse.status !== 200 ||
      !isRecord(meBody) ||
      !exactKeys(meBody, ["organizations", "principal"]) ||
      !Array.isArray(meBody.organizations) ||
      !validProofPrincipal(meBody.principal) ||
      !validProofPrincipal(principal) ||
      canonicalJson(meBody.principal) !== canonicalJson(principal)
    ) {
      proofFailure ??= verificationError(
        "operator identity /v1/me proof returned an invalid redacted response",
        `status=${meResponse.status}`,
      );
    }
  }
  const cleanup = await revokeProofSession(origin, sessionToken, fetcher);
  if (proofFailure) throw proofFailure;
  return {
    sessionStatus: 200,
    meStatus: 200,
    ...cleanup,
    sessionRevoked: true,
    assertionRedacted: true,
    sessionRedacted: true,
  };
}

async function revokeProofSession(
  origin: string,
  sessionToken: string,
  fetcher: (input: string, init?: RequestInit) => Promise<Response>,
): Promise<{ readonly revokeStatus: number | "transport-error"; readonly replayStatus: 401 }> {
  let revokeStatus: number | "transport-error" = "transport-error";
  try {
    const response = await fetcher(`${origin}/v1/session`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${sessionToken}`, "cache-control": "no-store" },
      redirect: "error",
    });
    revokeStatus = response.status;
  } catch {
    // The read-only replay below is the authority for an acknowledgement that
    // may have been lost. The bearer itself never enters the diagnostic.
  }
  let replay: Response;
  try {
    replay = await fetcher(`${origin}/v1/me`, {
      method: "GET",
      headers: { authorization: `Bearer ${sessionToken}`, "cache-control": "no-store" },
      redirect: "error",
    });
  } catch {
    throw verificationError(
      "operator identity session revocation replay failed; credential state is indeterminate and redacted",
    );
  }
  if (replay.status !== 401) {
    throw verificationError(
      "operator identity proof session remains usable after revocation",
      `revoke_status=${revokeStatus} replay_status=${replay.status}`,
    );
  }
  return { revokeStatus, replayStatus: 401 };
}

function validProofPrincipal(value: unknown): value is Record<string, unknown> {
  return (
    isRecord(value) &&
    exactKeys(value, ["displayName", "email", "id", "provider", "providerSubject"]) &&
    typeof value.id === "string" &&
    value.id.length > 0 &&
    value.provider === "google" &&
    value.providerSubject === "task-0037-integration-operator" &&
    value.email === "task-0037-integration-operator@localhost" &&
    value.displayName === "TASK-0037 Integration Operator"
  );
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}

function redactDiagnostics(value: string, secrets: readonly (string | undefined)[]): string {
  let redacted = value;
  for (const secret of secrets) {
    if (secret) redacted = redacted.replaceAll(secret, "[redacted]");
  }
  return redacted;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
