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
  activePublicJwk,
  createRemoteSigningDatabase,
  type SigningPublicKeyRow,
} from "./signing.ts";
import type { DeployTarget } from "./target.ts";
import {
  inspectLiveWorkerVersion,
  type LiveWorkerVersion,
  type WorkerState,
} from "./worker-live.ts";

const HOSTED_SECRET = "TAKOSERVER_HOSTED_SPONSORSHIP_TOKEN";

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
    });
    const state =
      options.state ??
      new CloudflareState({
        accountId: target.accountId,
        token: exactCloudflareToken(environment),
      });
    const database = options.database ?? remoteHostedDatabase(configPath, environment, run);
    if (invocation.action === "status") {
      return await hostedStatus(invocation, target, state);
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
    );
  } finally {
    if (temporary) rmSync(root, { recursive: true, force: true });
  }
}

async function hostedStatus(
  invocation: HostedInvocation,
  target: DeployTarget,
  state: WorkerState,
): Promise<Record<string, unknown>> {
  const desiredSecrets = expectedWorkerSecrets(target);
  const preTokenSecrets = desiredSecrets.filter((name) => name !== HOSTED_SECRET);
  let tokenPresent = true;
  let live: LiveWorkerVersion;
  try {
    live = await inspectLiveWorkerVersion("preflight", target, state, {
      signingKeyId: target.signing.currentKeyId,
      expectedSecrets: desiredSecrets,
    });
  } catch {
    tokenPresent = false;
    live = await inspectLiveWorkerVersion("preflight", target, state, {
      signingKeyId: target.signing.currentKeyId,
      expectedSecrets: preTokenSecrets,
    });
  }
  return {
    kind: "takoserver.hosted-token-cutover-status@v2",
    surface: invocation.surface,
    environment: invocation.environment,
    selectedCommit: invocation.commit,
    deployedCommit: live.commit,
    versionId: live.history.versionId,
    hostedTokenPresent: tokenPresent,
    ready: live.commit === invocation.commit && !tokenPresent,
  };
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
): Promise<Record<string, unknown>> {
  const desiredSecrets = expectedWorkerSecrets(target);
  const preTokenSecrets = desiredSecrets.filter((name) => name !== HOSTED_SECRET);
  const before = await inspectLiveWorkerVersion("preflight", target, state, {
    signingKeyId: target.signing.currentKeyId,
    expectedSecrets: preTokenSecrets,
  });
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
  const publicJwk = activePublicJwk(row, target.signing.currentKeyId);
  const tenantRef = await database.proofTenant("preflight");
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
  const after = await inspectLiveWorkerVersion("verification", target, state, {
    signingKeyId: target.signing.currentKeyId,
    expectedSecrets: desiredSecrets,
  });
  assertOnlyConfiguredStateAdvance(before, after, "Hosted token cutover");
  const proof = await proveHostedCredential(
    target.publicOrigin,
    tenantRef,
    token,
    target.signing.currentKeyId,
    publicJwk,
    options.fetcher ?? ((input, init) => fetch(input, init)),
  );
  assertSigningRow(await database.readSigningKey(target.signing.currentKeyId, "verification"), row);
  return {
    kind: "takoserver.hosted-token-cutover-apply@v2",
    surface: invocation.surface,
    environment: invocation.environment,
    commit: source.commit,
    reviewer,
    previousVersionId: before.history.versionId,
    versionId: after.history.versionId,
    proof,
    rollback:
      `remove the newly added secret with ` +
      `wrangler secret delete ${HOSTED_SECRET} --name ${target.workerName}`,
  };
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
    typeof claims.jti !== "string" ||
    !Number.isSafeInteger(claims.iat) ||
    claims.nbf !== claims.iat ||
    !Number.isSafeInteger(claims.exp) ||
    Number(claims.iat) > Math.floor(Date.now() / 1_000) ||
    Number(claims.exp) <= Math.floor(Date.now() / 1_000) ||
    Number(claims.exp) <= Number(claims.iat) ||
    Number(claims.exp) - Number(claims.iat) > 60
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

function assertSigningRow(actual: SigningPublicKeyRow | null, expected: SigningPublicKeyRow): void {
  if (
    actual?.keyId !== expected.keyId ||
    actual.publicJwk !== expected.publicJwk ||
    actual.createdAtEpochSeconds !== expected.createdAtEpochSeconds ||
    actual.revokedAtEpochSeconds !== null
  ) {
    throw verificationError(`D1 signing identity ${expected.keyId} changed during Hosted cutover`);
  }
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

function assertOnlyConfiguredStateAdvance(
  before: LiveWorkerVersion,
  after: LiveWorkerVersion,
  label: string,
): void {
  if (
    after.history.versionId === before.history.versionId ||
    after.history.previousVersionId !== before.history.versionId ||
    after.commit !== before.commit ||
    after.bundleDigestHex !== before.bundleDigestHex
  ) {
    throw verificationError(`${label} changed the served code identity`);
  }
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
