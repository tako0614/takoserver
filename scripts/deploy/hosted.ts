import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CloudflareState } from "./cloudflare-state.ts";
import { RemoteD1 } from "./d1.ts";
import { type DeployPhase, mutationError, preflightError, verificationError } from "./errors.ts";
import {
  type CommandResult,
  cloudflareChildEnvironment,
  REPOSITORY,
  requireEnvironment,
  runCommand,
  wranglerCommand,
} from "./process.ts";
import { type DeployEnvironment, qualifySource } from "./qualification.ts";
import { expectedWorkerSecrets, writeWorkerConfig } from "./realized-config.ts";
import {
  activeHostedTokenCutoverPublicJwk,
  createRemoteSigningDatabase,
  type SigningPublicKeyRow,
} from "./signing.ts";
import type { DeployTarget } from "./target.ts";
import {
  type CanonicalWorkerVersionWithScriptIdentity,
  inspectCanonicalWorkerVersionWithScriptIdentity,
  inspectSecretCreatedDirectSuccessor,
  type SecretCreatedDirectSuccessor,
  type WorkerState,
  workerVersionAnnotationProfile,
} from "./worker-live.ts";
import { parseWorkerDeploymentHistory, workerSecretInventoryIncludes } from "./worker-state.ts";

const HOSTED_SECRET = "TAKOSERVER_HOSTED_SPONSORSHIP_TOKEN";
const TOKEN_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{2,255}$/u;

export interface HostedDatabase {
  readSigningKey(keyId: string, phase: DeployPhase): Promise<SigningPublicKeyRow | null>;
  proofTenant(phase: DeployPhase): Promise<string>;
}

export type HostedProcess = (
  command: readonly string[],
  options?: { readonly env?: Readonly<Record<string, string>>; readonly input?: string },
) => Promise<CommandResult>;

export interface HostedInvocation {
  readonly surface: "takoserver-hosted-token-cutover";
  readonly action: "status" | "apply";
  readonly environment: DeployEnvironment;
  readonly commit: string;
}

export interface HostedOptions {
  readonly run?: HostedProcess;
  readonly database?: HostedDatabase;
  readonly state?: WorkerState;
  readonly tokenPath?: string;
  readonly review?: string;
  readonly outputDirectory?: string;
  readonly cloudflareEnvironment?: Readonly<Record<string, string>>;
  readonly fetcher?: (input: string, init?: RequestInit) => Promise<Response>;
}

/** Installs and proves the product-owned sponsorship bearer. */
export async function runHosted(
  invocation: HostedInvocation,
  target: DeployTarget,
  options: HostedOptions = {},
): Promise<Record<string, unknown>> {
  if (target.environment !== invocation.environment) {
    throw preflightError("Hosted invocation and target environments differ");
  }
  if (target.sponsorship !== true) {
    throw preflightError("Hosted token cutover requires target sponsorship");
  }
  const run = options.run ?? runCommand;
  const environment =
    options.cloudflareEnvironment ??
    (options.database !== undefined && options.state !== undefined && invocation.action === "status"
      ? {}
      : cloudflareChildEnvironment());
  const temporary = options.outputDirectory === undefined;
  const root = options.outputDirectory ?? mkdtempSync(join(tmpdir(), "takoserver-hosted-"));
  mkdirSync(root, { recursive: true, mode: 0o700 });
  try {
    const configPath = writeWorkerConfig(target, {
      path: join(root, "inspect-wrangler.jsonc"),
      main: resolve(REPOSITORY, "src/entry-cloudflare-worker.ts"),
      commit: invocation.commit,
      signingKeyId: target.signing.currentKeyId,
      omitIntegrationE2eCredentialAuthority: true,
    });
    const state =
      options.state ??
      new CloudflareState({
        accountId: target.accountId,
        token: exactCloudflareToken(environment),
      });
    if (invocation.action === "status") {
      return await hostedStatus(invocation, target, state);
    }
    const inspection = await inspectHostedState("preflight", invocation, target, state);
    if (inspection.kind === "canonical-pre-token" && invocation.environment !== "integration") {
      throw preflightError("fresh Hosted token cutover is integration-only");
    }
    const database = options.database ?? remoteHostedDatabase(configPath, environment, run);
    if (inspection.kind === "hosted-token-added-unattributed-successor") {
      return await recoverHostedToken(
        invocation,
        target,
        state,
        database,
        inspection.successor,
        run,
        options,
      );
    }
    if (inspection.kind === "canonical-token-present") {
      return await proveCanonicalHostedToken(
        invocation,
        target,
        state,
        database,
        inspection.live,
        run,
        options,
      );
    }
    return await cutoverHostedToken(
      invocation,
      target,
      state,
      database,
      configPath,
      environment,
      run,
      options,
      inspection.live,
    );
  } finally {
    if (temporary) rmSync(root, { recursive: true, force: true });
  }
}

async function proveCanonicalHostedToken(
  invocation: HostedInvocation,
  target: DeployTarget,
  state: WorkerState,
  database: HostedDatabase,
  before: CanonicalWorkerVersionWithScriptIdentity,
  run: HostedProcess,
  options: HostedOptions,
): Promise<Record<string, unknown>> {
  const source = await qualifyHostedProofSource(invocation, run);
  if (before.commit !== source.commit) {
    throw preflightError("canonical Hosted token Worker does not match the selected source");
  }
  const reviewer = exactReviewer(
    options.review ?? requireEnvironment("TAKOSERVER_INDEPENDENT_REVIEW"),
  );
  const token = readHostedToken(
    options.tokenPath ?? requireEnvironment("TAKOSERVER_HOSTED_TOKEN_PATH"),
  );
  const row = await database.readSigningKey(target.signing.currentKeyId, "preflight");
  if (row === null) throw preflightError("current signing identity disappeared before proof");
  const publicJwk = activeHostedTokenCutoverPublicJwk(
    row,
    target.signing.currentKeyId,
    invocation.environment,
  );
  const tenantRef = exactProofTenant(await database.proofTenant("preflight"), "preflight");
  const requalified = await inspectCanonicalWorkerVersionWithScriptIdentity(
    "preflight",
    target,
    state,
    {
      signingKeyId: target.signing.currentKeyId,
      expectedSecrets: expectedWorkerSecrets(target),
      selectedCommit: source.commit,
    },
  );
  if (!sameCanonicalVersion(before, requalified)) {
    throw preflightError("canonical Hosted token Worker changed while proof was prepared");
  }
  assertSigningRow(
    "preflight",
    await database.readSigningKey(target.signing.currentKeyId, "preflight"),
    row,
  );
  if (exactProofTenant(await database.proofTenant("preflight"), "preflight") !== tenantRef) {
    throw preflightError("Hosted credential proof tenant changed before HTTP proof");
  }
  const proof = {
    ...(await proveHostedCredential(
      target.publicOrigin,
      tenantRef,
      token,
      target.signing.currentKeyId,
      publicJwk,
      options.fetcher ?? ((input, init) => fetch(input, init)),
    )),
    publicJwkDigest: sha256(row.publicJwk),
  };
  const final = await inspectHostedState("verification", invocation, target, state);
  if (final.kind !== "canonical-token-present" || !sameCanonicalVersion(before, final.live)) {
    throw verificationError("canonical Hosted token Worker changed during functional proof");
  }
  assertSigningRow(
    "verification",
    await database.readSigningKey(target.signing.currentKeyId, "verification"),
    row,
  );
  return {
    kind: "takoserver.hosted-token-cutover-apply@v2",
    surface: invocation.surface,
    environment: invocation.environment,
    commit: source.commit,
    reviewer,
    state: "canonical-token-present",
    mutationApplied: false,
    functionalProofPending: false,
    repairRequired: false,
    ready: true,
    versionId: before.history.versionId,
    previousVersionId: before.history.previousVersionId,
    artifactDigest: `sha256:${before.bundleDigestHex}`,
    scriptContentIdentity: before.scriptEtag,
    proof,
  };
}

async function hostedStatus(
  invocation: HostedInvocation,
  target: DeployTarget,
  state: WorkerState,
): Promise<Record<string, unknown>> {
  const inspection = await inspectHostedState("preflight", invocation, target, state);
  if (inspection.kind === "canonical-pre-token") {
    const { live } = inspection;
    const cutoverApplyReady =
      invocation.environment === "integration" && live.commit === invocation.commit;
    return {
      kind: "takoserver.hosted-token-cutover-status@v2",
      surface: invocation.surface,
      environment: invocation.environment,
      selectedCommit: invocation.commit,
      state: "canonical-pre-token",
      mutationApplied: false,
      functionalProofPending: false,
      repairRequired: false,
      deployedCommit: live.commit,
      artifactDigest: `sha256:${live.bundleDigestHex}`,
      versionId: live.history.versionId,
      previousVersionId: live.history.previousVersionId,
      hostedTokenPresent: false,
      cutoverApplyReady,
      ready: cutoverApplyReady,
    };
  }
  if (inspection.kind === "canonical-token-present") {
    const { live } = inspection;
    return {
      kind: "takoserver.hosted-token-cutover-status@v2",
      surface: invocation.surface,
      environment: invocation.environment,
      selectedCommit: invocation.commit,
      state: "canonical-token-present",
      mutationApplied: true,
      functionalProofPending: true,
      repairRequired: false,
      deployedCommit: live.commit,
      artifactDigest: `sha256:${live.bundleDigestHex}`,
      versionId: live.history.versionId,
      previousVersionId: live.history.previousVersionId,
      hostedTokenPresent: true,
      proofApplyReady: live.commit === invocation.commit,
      ready: false,
    };
  }
  const successor = inspection.successor;
  return {
    kind: "takoserver.hosted-token-cutover-status@v2",
    surface: invocation.surface,
    environment: invocation.environment,
    selectedCommit: invocation.commit,
    state: "hosted-token-added-unattributed-successor",
    mutationApplied: true,
    functionalProofPending: true,
    repairRequired: true,
    deployedCommit: successor.predecessorCommit,
    artifactDigest: `sha256:${successor.predecessorBundleDigestHex}`,
    inheritedCommit: successor.predecessorCommit,
    inheritedBundleDigest: `sha256:${successor.predecessorBundleDigestHex}`,
    versionId: successor.successorVersionId,
    previousVersionId: successor.predecessorVersionId,
    hostedTokenPresent: true,
    scriptContentIdentity: successor.successorScriptEtag,
    provenance: successor.provenance,
    ready: false,
  };
}

type HostedInspection =
  | {
      readonly kind: "canonical-pre-token";
      readonly live: CanonicalWorkerVersionWithScriptIdentity;
    }
  | {
      readonly kind: "canonical-token-present";
      readonly live: CanonicalWorkerVersionWithScriptIdentity;
    }
  | {
      readonly kind: "hosted-token-added-unattributed-successor";
      readonly successor: SecretCreatedDirectSuccessor;
    };

async function inspectHostedState(
  phase: DeployPhase,
  invocation: HostedInvocation,
  target: DeployTarget,
  state: WorkerState,
): Promise<HostedInspection> {
  const desiredSecrets = expectedWorkerSecrets(target);
  const preTokenSecrets = desiredSecrets.filter((name) => name !== HOSTED_SECRET);
  const inventory = await state.workerSecrets(target.workerName);
  const tokenPresent = workerSecretInventoryIncludes(inventory, HOSTED_SECRET, phase);
  if (tokenPresent) {
    const history = parseWorkerDeploymentHistory(
      await state.workerDeployments(target.workerName),
      phase,
    );
    if (history === null) {
      throw phaseError(phase, "Worker has no authoritative current deployment");
    }
    const version = await state.workerVersion(target.workerName, history.versionId);
    const annotation = workerVersionAnnotationProfile(version);
    if (annotation === "canonical") {
      const live = await inspectCanonicalWorkerVersionWithScriptIdentity(phase, target, state, {
        signingKeyId: target.signing.currentKeyId,
        expectedSecrets: desiredSecrets,
        secretInventory: inventory,
      });
      return { kind: "canonical-token-present", live };
    }
    if (invocation.environment !== "integration") {
      throw phaseError(phase, "unannotated Hosted token successor recovery is integration-only");
    }
    if (annotation !== "secret-created") {
      throw phaseError(phase, "Hosted token successor has no exact authority annotation profile");
    }
    const successor = await inspectSecretCreatedDirectSuccessor(phase, target, state, {
      addedSecret: HOSTED_SECRET,
      signingKeyId: target.signing.currentKeyId,
      selectedCommit: invocation.commit,
      secretInventory: inventory,
      expectedSuccessorVersionId: history.versionId,
    });
    return { kind: "hosted-token-added-unattributed-successor", successor };
  }
  const live = await inspectCanonicalWorkerVersionWithScriptIdentity(phase, target, state, {
    signingKeyId: target.signing.currentKeyId,
    expectedSecrets: preTokenSecrets,
    secretInventory: inventory,
  });
  return { kind: "canonical-pre-token", live };
}

async function cutoverHostedToken(
  invocation: HostedInvocation,
  target: DeployTarget,
  state: WorkerState,
  database: HostedDatabase,
  configPath: string,
  environment: Readonly<Record<string, string>>,
  run: HostedProcess,
  options: HostedOptions,
  before: CanonicalWorkerVersionWithScriptIdentity,
): Promise<Record<string, unknown>> {
  const source = await qualifySource({
    environment: invocation.environment === "integration" ? "integration" : "production",
    commit: invocation.commit,
    run,
  });
  if (before.commit !== source.commit) {
    throw preflightError(
      "Hosted token cutover commit must equal the currently served Worker commit",
    );
  }
  const reviewer = exactReviewer(
    options.review ?? requireEnvironment("TAKOSERVER_INDEPENDENT_REVIEW"),
  );
  const token = readHostedToken(
    options.tokenPath ?? requireEnvironment("TAKOSERVER_HOSTED_TOKEN_PATH"),
  );
  const row = await database.readSigningKey(target.signing.currentKeyId, "preflight");
  if (row === null) throw preflightError("current signing identity disappeared before cutover");
  const publicJwk = activeHostedTokenCutoverPublicJwk(
    row,
    target.signing.currentKeyId,
    invocation.environment,
  );
  const tenantRef = await database.proofTenant("preflight");
  const preTokenSecrets = expectedWorkerSecrets(target).filter((name) => name !== HOSTED_SECRET);
  const requalified = await inspectCanonicalWorkerVersionWithScriptIdentity(
    "preflight",
    target,
    state,
    {
      signingKeyId: target.signing.currentKeyId,
      expectedSecrets: preTokenSecrets,
      selectedCommit: source.commit,
    },
  );
  if (!sameCanonicalVersion(before, requalified)) {
    throw preflightError("canonical Worker predecessor changed while Hosted cutover was prepared");
  }
  assertSigningRow(
    "preflight",
    await database.readSigningKey(target.signing.currentKeyId, "preflight"),
    row,
  );
  if ((await database.proofTenant("preflight")) !== tenantRef) {
    throw preflightError("Hosted credential proof tenant changed before token mutation");
  }
  const mutation = await run(
    wranglerCommand([
      "secret",
      "put",
      HOSTED_SECRET,
      "--name",
      target.workerName,
      "--config",
      configPath,
    ]),
    { env: environment, input: token },
  );
  if (mutation.exitCode !== 0) {
    throw mutationError(
      "Hosted token cutover acknowledgement is indeterminate; do not retry before --status",
      `${mutation.stdout}${mutation.stderr}`.trim(),
    );
  }
  const after = await inspectSecretCreatedDirectSuccessor("verification", target, state, {
    addedSecret: HOSTED_SECRET,
    signingKeyId: target.signing.currentKeyId,
    selectedCommit: source.commit,
    expectedPredecessorVersionId: before.history.versionId,
  });
  const proof = await proveHostedCredential(
    target.publicOrigin,
    tenantRef,
    token,
    target.signing.currentKeyId,
    publicJwk,
    options.fetcher ?? ((input, init) => fetch(input, init)),
  );
  const final = await inspectHostedState("verification", invocation, target, state);
  if (
    final.kind !== "hosted-token-added-unattributed-successor" ||
    !sameSecretCreatedSuccessor(after, final.successor)
  ) {
    throw verificationError("Hosted token cutover observed a changed final Worker successor");
  }
  assertSigningRow(
    "verification",
    await database.readSigningKey(target.signing.currentKeyId, "verification"),
    row,
  );
  return {
    kind: "takoserver.hosted-token-cutover-apply@v2",
    surface: invocation.surface,
    environment: invocation.environment,
    commit: source.commit,
    reviewer,
    state: "hosted-token-added-unattributed-successor",
    mutationApplied: true,
    functionalProofPending: false,
    repairRequired: true,
    ready: false,
    previousVersionId: after.predecessorVersionId,
    versionId: after.successorVersionId,
    artifactDigest: `sha256:${after.predecessorBundleDigestHex}`,
    scriptContentIdentity: after.successorScriptEtag,
    provenance: after.provenance,
    proof,
    rollback:
      `remove the newly added secret with ` +
      `wrangler secret delete ${HOSTED_SECRET} --name ${target.workerName}`,
  };
}

async function recoverHostedToken(
  invocation: HostedInvocation,
  target: DeployTarget,
  state: WorkerState,
  database: HostedDatabase,
  successor: SecretCreatedDirectSuccessor,
  run: HostedProcess,
  options: HostedOptions,
): Promise<Record<string, unknown>> {
  const source = await qualifyHostedProofSource(invocation, run);
  if (source.commit !== successor.predecessorCommit) {
    throw preflightError("Hosted token recovery source does not match the canonical predecessor");
  }
  const reviewer = exactReviewer(
    options.review ?? requireEnvironment("TAKOSERVER_INDEPENDENT_REVIEW"),
  );
  const token = readHostedToken(
    options.tokenPath ?? requireEnvironment("TAKOSERVER_HOSTED_TOKEN_PATH"),
  );
  const row = await database.readSigningKey(target.signing.currentKeyId, "preflight");
  if (row === null)
    throw preflightError("current signing identity disappeared before proof recovery");
  const publicJwk = activeHostedTokenCutoverPublicJwk(
    row,
    target.signing.currentKeyId,
    invocation.environment,
  );
  const tenantRef = await database.proofTenant("preflight");
  const proof = await proveHostedCredential(
    target.publicOrigin,
    tenantRef,
    token,
    target.signing.currentKeyId,
    publicJwk,
    options.fetcher ?? ((input, init) => fetch(input, init)),
  );
  const final = await inspectHostedState("verification", invocation, target, state);
  if (
    final.kind !== "hosted-token-added-unattributed-successor" ||
    !sameSecretCreatedSuccessor(final.successor, successor)
  ) {
    throw verificationError("Hosted token proof recovery observed a changed Worker successor");
  }
  assertSigningRow(
    "verification",
    await database.readSigningKey(target.signing.currentKeyId, "verification"),
    row,
  );
  return {
    kind: "takoserver.hosted-token-cutover-apply@v2",
    surface: invocation.surface,
    environment: invocation.environment,
    commit: source.commit,
    reviewer,
    state: "hosted-token-added-unattributed-successor",
    mutationApplied: false,
    functionalProofPending: false,
    repairRequired: true,
    ready: false,
    previousVersionId: successor.predecessorVersionId,
    versionId: successor.successorVersionId,
    artifactDigest: `sha256:${successor.predecessorBundleDigestHex}`,
    scriptContentIdentity: successor.successorScriptEtag,
    provenance: successor.provenance,
    proof,
  };
}

async function qualifyHostedProofSource(invocation: HostedInvocation, run: HostedProcess) {
  const source = await qualifySource({
    environment: invocation.environment === "integration" ? "integration" : "production",
    commit: invocation.commit,
    run,
  });
  const fetched = await run(["git", "fetch", "--quiet", "--all", "--prune"]);
  if (fetched.exitCode !== 0) {
    throw preflightError(
      `Hosted proof source remote qualification failed (exit ${fetched.exitCode})`,
      `${fetched.stdout}${fetched.stderr}`.trim(),
    );
  }
  const contains = await run(["git", "branch", "-r", "--contains", source.commit]);
  if (contains.exitCode !== 0) {
    throw preflightError(
      `Hosted proof source remote reachability failed (exit ${contains.exitCode})`,
      `${contains.stdout}${contains.stderr}`.trim(),
    );
  }
  const remoteRefs = contains.stdout
    .split("\n")
    .map((line) => line.trim().replace(/^\*\s*/u, ""))
    .filter((line) => line.length > 0 && !line.includes(" -> "));
  if (
    remoteRefs.length === 0 ||
    remoteRefs.some((line) => !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$/u.test(line))
  ) {
    throw preflightError("Hosted proof source commit is not reachable from an exact remote ref");
  }
  return source;
}

function remoteHostedDatabase(
  configPath: string,
  environment: Readonly<Record<string, string>>,
  run: HostedProcess,
): HostedDatabase {
  const signing = createRemoteSigningDatabase(configPath, environment, run);
  const d1 = new RemoteD1(configPath, { environment, run });
  return {
    readSigningKey: (keyId, phase) => signing.readKey(keyId, phase),
    async proofTenant(phase) {
      const tenants = await d1.column(
        phase,
        "Hosted proof tenant",
        "SELECT tenant_ref FROM sponsorship_tenants ORDER BY tenant_ref LIMIT 1",
        "tenant_ref",
      );
      const tenant = tenants[0];
      if (!tenant) throw phaseError(phase, "Hosted credential proof has no sponsorship tenant");
      return tenant;
    },
  };
}

async function proveHostedCredential(
  origin: string,
  tenantRef: string,
  token: string,
  keyId: string,
  publicJwk: JsonWebKey,
  fetcher: (input: string, init?: RequestInit) => Promise<Response>,
): Promise<{
  readonly keyId: string;
  readonly tenantRef: string;
  readonly lifetimeSeconds: number;
}> {
  let response: Response;
  try {
    response = await fetcher(
      `${origin}/v1/sponsorship/tenants/${encodeURIComponent(tenantRef)}/takoform-run-credentials`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({
          runRef: "deploy-hosted-proof",
          spaceRef: "deploy-hosted-proof",
          expiresInSeconds: 60,
        }),
        redirect: "error",
      },
    );
  } catch (error) {
    throw verificationError(
      "bounded Hosted credential proof failed",
      error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    );
  }
  const body = (await response.json().catch(() => null)) as unknown;
  if (
    response.status !== 201 ||
    !isRecord(body) ||
    !isRecord(body.takoformRunCredential) ||
    typeof body.takoformRunCredential.token !== "string"
  ) {
    throw verificationError("bounded Hosted credential proof returned an invalid response");
  }
  const jwt = body.takoformRunCredential.token;
  const parts = jwt.split(".");
  if (parts.length !== 3 || parts.some((part) => !part)) {
    throw verificationError("bounded Hosted credential proof returned a malformed JWT");
  }
  const [headerPart, payloadPart, signaturePart] = parts as [string, string, string];
  const header = jwtRecord(headerPart);
  const claims = jwtRecord(payloadPart);
  if (
    !exactKeys(header, ["alg", "kid", "typ"]) ||
    header.alg !== "EdDSA" ||
    header.kid !== keyId ||
    header.typ !== "takoserver-token+jwt" ||
    !exactKeys(claims, [
      "aud",
      "exp",
      "iat",
      "iss",
      "jti",
      "mode",
      "nbf",
      "organizationId",
      "runRef",
      "spaceRef",
      "tenantRef",
    ]) ||
    claims.aud !== "takoform.run" ||
    claims.iss !== origin ||
    claims.tenantRef !== tenantRef ||
    claims.mode !== "tenant-run" ||
    claims.runRef !== "deploy-hosted-proof" ||
    claims.spaceRef !== "deploy-hosted-proof" ||
    typeof claims.organizationId !== "string" ||
    !TOKEN_REFERENCE.test(claims.organizationId) ||
    typeof claims.jti !== "string" ||
    !TOKEN_REFERENCE.test(claims.jti) ||
    !Number.isSafeInteger(claims.iat) ||
    claims.nbf !== claims.iat ||
    !Number.isSafeInteger(claims.exp) ||
    Number(claims.iat) > Math.floor(Date.now() / 1_000) ||
    Number(claims.exp) <= Math.floor(Date.now() / 1_000) ||
    Number(claims.exp) <= Number(claims.iat) ||
    Number(claims.exp) - Number(claims.iat) !== 60
  ) {
    throw verificationError("bounded Hosted credential proof carries invalid claims");
  }
  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey("jwk", publicJwk, { name: "Ed25519" }, false, ["verify"]);
  } catch {
    throw verificationError("D1 public key cannot verify the Hosted credential proof");
  }
  const verified = await crypto.subtle
    .verify(
      "Ed25519",
      key,
      Buffer.from(signaturePart, "base64url"),
      new TextEncoder().encode(`${headerPart}.${payloadPart}`),
    )
    .catch(() => false);
  if (!verified) throw verificationError("Hosted credential proof has the wrong signature");
  return {
    keyId,
    tenantRef,
    lifetimeSeconds: Number(claims.exp) - Number(claims.iat),
  };
}

function assertSigningRow(
  phase: "preflight" | "verification",
  actual: SigningPublicKeyRow | null,
  expected: SigningPublicKeyRow,
): void {
  if (
    actual?.keyId !== expected.keyId ||
    actual.publicJwk !== expected.publicJwk ||
    actual.createdAtEpochSeconds !== expected.createdAtEpochSeconds ||
    actual.revokedAtEpochSeconds !== null
  ) {
    throw phaseError(phase, `D1 signing identity ${expected.keyId} changed during Hosted cutover`);
  }
}

function sameCanonicalVersion(
  left: CanonicalWorkerVersionWithScriptIdentity,
  right: CanonicalWorkerVersionWithScriptIdentity,
): boolean {
  return (
    left.history.deploymentId === right.history.deploymentId &&
    left.history.versionId === right.history.versionId &&
    left.history.previousVersionId === right.history.previousVersionId &&
    left.commit === right.commit &&
    left.bundleDigestHex === right.bundleDigestHex &&
    left.scriptEtag === right.scriptEtag
  );
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function sameSecretCreatedSuccessor(
  left: SecretCreatedDirectSuccessor,
  right: SecretCreatedDirectSuccessor,
): boolean {
  return (
    left.history.deploymentId === right.history.deploymentId &&
    left.history.versionId === right.history.versionId &&
    left.history.previousVersionId === right.history.previousVersionId &&
    left.predecessorVersionId === right.predecessorVersionId &&
    left.successorVersionId === right.successorVersionId &&
    left.predecessorCommit === right.predecessorCommit &&
    left.predecessorBundleDigestHex === right.predecessorBundleDigestHex &&
    left.predecessorScriptEtag === right.predecessorScriptEtag &&
    left.successorScriptEtag === right.successorScriptEtag
  );
}

export function readHostedToken(path: string): string {
  let status: ReturnType<typeof lstatSync>;
  let raw: string;
  try {
    status = lstatSync(path);
    raw = readFileSync(path, "utf8");
  } catch {
    throw preflightError("Hosted token file is unavailable");
  }
  if (
    !status.isFile() ||
    status.isSymbolicLink() ||
    status.nlink !== 1 ||
    (status.mode & 0o777) !== 0o600 ||
    (typeof process.getuid === "function" && status.uid !== process.getuid()) ||
    raw.length < 8 ||
    raw.length > 16_384 ||
    raw.trim() !== raw ||
    [...raw].some((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint !== undefined && (codePoint <= 31 || codePoint === 127);
    })
  ) {
    throw preflightError("Hosted token must be an owned 0600 exact non-whitespace regular file");
  }
  return raw;
}

function jwtRecord(part: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
    if (isRecord(parsed)) return parsed;
  } catch {
    // Refuse below without reflecting credential bytes.
  }
  throw verificationError("bounded Hosted credential proof contains malformed JSON");
}

function exactReviewer(value: string): string {
  if (value.trim() !== value || value.length < 1 || value.length > 256 || value.includes("\n")) {
    throw preflightError("TAKOSERVER_INDEPENDENT_REVIEW must name one reviewer");
  }
  return value;
}

function exactProofTenant(value: string, phase: "preflight" | "verification"): string {
  if (!TOKEN_REFERENCE.test(value)) {
    throw phaseError(phase, "Hosted credential proof tenant has an invalid exact reference");
  }
  return value;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}

function exactCloudflareToken(environment: Readonly<Record<string, string>>): string {
  const value = environment.CLOUDFLARE_API_TOKEN;
  if (!value) throw preflightError("CLOUDFLARE_API_TOKEN is required");
  return value;
}

function phaseError(phase: DeployPhase, message: string) {
  return phase === "preflight"
    ? preflightError(message)
    : phase === "mutation"
      ? mutationError(message)
      : verificationError(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
