import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CloudflareState } from "./cloudflare-state.ts";
import type { CloudflareTopologyAuditEvidence } from "./cloudflare-topology-audit.ts";
import {
  type DeployError,
  type DeployPhase,
  mutationError,
  preflightError,
  verificationError,
} from "./errors.ts";
import {
  type CommandResult,
  REPOSITORY,
  requireEnvironment,
  resolveCloudflareCredential,
  runCommand,
  wranglerCommand,
} from "./process.ts";
import { type DeployEnvironment, qualifySource, unsealDirectory } from "./qualification.ts";
import {
  activePublicJwk,
  createRemoteSigningDatabase,
  readVerifiedPrivateSigningJwk,
  type SigningDatabase,
  type SigningPublicKeyRow,
} from "./signing.ts";
import type { DeployTarget } from "./target.ts";
import { prepareWorkerArtifact } from "./worker-artifact.ts";
import { workerVersionScriptContentIdentity } from "./worker-live.ts";
import {
  assertExactSecretInventory,
  assertExactVersionBindingClosure,
  type ExpectedBindingClosure,
  parseWorkerDeploymentHistory,
  type WorkerDeploymentHistory,
} from "./worker-state.ts";

const CREDENTIAL_SIGNING_SECRET = "TAKOSERVER_SPONSORSHIP_CREDENTIAL_SIGNING_KEY";
const RECEIPT_SIGNING_SECRET = "TAKOSERVER_SPONSORSHIP_RECEIPT_SIGNING_KEY";
const ORGANIZATION_BINDING = "TAKOSERVER_SPONSORSHIP_ORGANIZATION_ID";
const ISSUER_BINDING = "TAKOSERVER_SPONSORSHIP_TOKEN_ISSUER";
const CREDENTIAL_KEY_ID_BINDING = "TAKOSERVER_SPONSORSHIP_CREDENTIAL_KEY_ID";
const CREDENTIAL_PUBLIC_JWK_BINDING = "TAKOSERVER_SPONSORSHIP_CREDENTIAL_PUBLIC_JWK";
const RECEIPT_KEY_ID_BINDING = "TAKOSERVER_SPONSORSHIP_RECEIPT_KEY_ID";
const AUTHORITY_WORKER_BINDING = "TAKOSERVER_SPONSORSHIP_AUTHORITY_WORKER_NAME";
const AUTHORITY_SOURCE_BINDING = "TAKOSERVER_SPONSORSHIP_AUTHORITY_SOURCE_COMMIT";
const AUTHORITY_ARTIFACT_BINDING = "TAKOSERVER_SPONSORSHIP_AUTHORITY_ARTIFACT_SHA256";
const VERSION_BINDING = "WORKER_VERSION";

export interface SponsorshipAuthorityDeployInvocation {
  readonly surface: "takoserver-sponsorship-authority-worker";
  readonly action: "status" | "apply";
  readonly environment: DeployEnvironment;
  readonly commit: string;
}

export interface SponsorshipAuthorityDeployState {
  workerScripts(): Promise<readonly string[]>;
  workerDeployments(workerName: string): Promise<readonly unknown[]>;
  workerVersion(workerName: string, versionId: string): Promise<unknown>;
  workerSecrets(workerName: string): Promise<readonly unknown[]>;
  workerDomains(): Promise<readonly { readonly hostname: string; readonly service: string }[]>;
  workerRoutes(): Promise<
    readonly {
      readonly zoneId: string;
      readonly id: string;
      readonly pattern: string;
      readonly script: string | null;
    }[]
  >;
  workerSubdomain(workerName: string): Promise<{
    readonly enabled: boolean;
    readonly previewsEnabled: boolean;
  }>;
  workerTopologyAudit(): Promise<CloudflareTopologyAuditEvidence>;
}

export type SponsorshipAuthorityDeployProcess = (
  command: readonly string[],
  options?: {
    readonly env?: Readonly<Record<string, string>>;
    readonly input?: string;
  },
) => Promise<CommandResult>;

export interface SponsorshipAuthorityDeployOptions {
  readonly run?: SponsorshipAuthorityDeployProcess;
  readonly state?: SponsorshipAuthorityDeployState;
  readonly database?: SigningDatabase;
  readonly privateJwkPath?: string;
  readonly receiptPrivateJwkPath?: string;
  readonly review?: string;
  readonly outputDirectory?: string;
  readonly cloudflareEnvironment?: Readonly<Record<string, string>>;
}

export interface SponsorshipAuthorityInspection {
  readonly history: WorkerDeploymentHistory;
  readonly commit: string;
  readonly artifactDigest: `sha256:${string}`;
  readonly scriptEtag: string;
  readonly topologyAudit: CloudflareTopologyAuditEvidence;
}

/** Prove every active ordinary key is distinct from both sponsorship authorities. */
export function assertDedicatedSponsorshipKeys(
  target: DeployTarget,
  ordinarySigningRow: SigningPublicKeyRow | null,
  credentialSigningRow: SigningPublicKeyRow | null,
  nextOrdinarySigningRow: SigningPublicKeyRow | null = null,
): void {
  const selected = requireAuthorityTarget(target);
  const ordinaryJwks = [activePublicJwk(ordinarySigningRow, target.signing.currentKeyId)];
  if (target.signing.nextKeyId !== undefined) {
    ordinaryJwks.push(activePublicJwk(nextOrdinarySigningRow, target.signing.nextKeyId));
  }
  if (credentialSigningRow !== null) {
    const credentialJwk = activePublicJwk(credentialSigningRow, selected.credentialKeyId);
    if (
      credentialSigningRow.publicJwk !== JSON.stringify(selected.credentialPublicJwk) ||
      credentialJwk.x !== selected.credentialPublicJwk.x
    ) {
      throw preflightError(
        "registered sponsorship credential public key does not match the deploy target",
      );
    }
  }
  if (
    ordinaryJwks.some(
      ({ x }) => x === selected.credentialPublicJwk.x || x === selected.receiptPublicJwk.x,
    ) ||
    selected.credentialPublicJwk.x === selected.receiptPublicJwk.x
  ) {
    throw preflightError(
      "run-token, sponsorship credential, and receipt public keys must all differ",
    );
  }
}

/** Append the target-pinned credential public key once and prove exact readback. */
export async function registerSponsorshipCredentialPublicKey(
  target: DeployTarget,
  database: SigningDatabase,
): Promise<{ readonly inserted: boolean; readonly row: SigningPublicKeyRow }> {
  const selected = requireAuthorityTarget(target);
  const ordinary = await database.readKey(target.signing.currentKeyId, "preflight");
  const nextOrdinary =
    target.signing.nextKeyId === undefined
      ? null
      : await database.readKey(target.signing.nextKeyId, "preflight");
  const before = await database.readKey(selected.credentialKeyId, "preflight");
  assertDedicatedSponsorshipKeys(target, ordinary, before, nextOrdinary);
  if (before === null) {
    await database.insertPublicKey(
      selected.credentialKeyId,
      JSON.stringify(selected.credentialPublicJwk),
    );
  }
  const after = await database.readKey(selected.credentialKeyId, "verification");
  if (after === null) {
    throw verificationError("sponsorship credential public key registration is missing");
  }
  try {
    assertDedicatedSponsorshipKeys(
      target,
      await database.readKey(target.signing.currentKeyId, "verification"),
      after,
      target.signing.nextKeyId === undefined
        ? null
        : await database.readKey(target.signing.nextKeyId, "verification"),
    );
  } catch {
    throw verificationError("sponsorship credential public key readback does not match target");
  }
  return { inserted: before === null, row: after };
}

/** Realize the route-less authority's complete D1/signing closure. */
export function writeSponsorshipAuthorityConfig(input: {
  readonly path: string;
  readonly main: string;
  readonly target: DeployTarget;
  readonly commit: string;
  readonly artifactDigest?: `sha256:${string}`;
}): string {
  const selected = requireAuthorityTarget(input.target);
  const config = {
    name: selected.workerName,
    main: input.main,
    account_id: input.target.accountId,
    compatibility_date: "2026-08-17",
    compatibility_flags: ["nodejs_compat"],
    workers_dev: false,
    preview_urls: false,
    vars: {
      [ORGANIZATION_BINDING]: selected.organizationId,
      [ISSUER_BINDING]: input.target.publicOrigin,
      [CREDENTIAL_KEY_ID_BINDING]: selected.credentialKeyId,
      [CREDENTIAL_PUBLIC_JWK_BINDING]: JSON.stringify(selected.credentialPublicJwk),
      [RECEIPT_KEY_ID_BINDING]: selected.receiptKeyId,
      [AUTHORITY_WORKER_BINDING]: selected.workerName,
      [AUTHORITY_SOURCE_BINDING]: input.commit,
      [AUTHORITY_ARTIFACT_BINDING]: input.artifactDigest ?? `sha256:${"0".repeat(64)}`,
    },
    secrets: { required: [CREDENTIAL_SIGNING_SECRET, RECEIPT_SIGNING_SECRET] },
    version_metadata: { binding: VERSION_BINDING },
    d1_databases: [
      {
        binding: "STATE_DB",
        database_name: input.target.d1.databaseName,
        database_id: input.target.d1.databaseId,
        migrations_dir: resolve(REPOSITORY, "migrations"),
      },
    ],
    observability: { enabled: true },
  };
  writeFileSync(input.path, `${JSON.stringify(config, null, 2)}\n`, {
    mode: 0o600,
  });
  return input.path;
}

/** Complete immutable binding readback; any extra capability is drift. */
export function sponsorshipAuthorityBindingClosure(
  target: DeployTarget,
  identity: {
    readonly commit: string;
    readonly artifactDigest: `sha256:${string}`;
  },
): ExpectedBindingClosure {
  const selected = requireAuthorityTarget(target);
  return {
    STATE_DB: { type: "d1", fields: { id: target.d1.databaseId } },
    [ORGANIZATION_BINDING]: {
      type: "plain_text",
      fields: { text: selected.organizationId },
    },
    [ISSUER_BINDING]: {
      type: "plain_text",
      fields: { text: target.publicOrigin },
    },
    [CREDENTIAL_KEY_ID_BINDING]: {
      type: "plain_text",
      fields: { text: selected.credentialKeyId },
    },
    [CREDENTIAL_PUBLIC_JWK_BINDING]: {
      type: "plain_text",
      fields: { text: JSON.stringify(selected.credentialPublicJwk) },
    },
    [CREDENTIAL_SIGNING_SECRET]: { type: "secret_text", fields: {} },
    [RECEIPT_SIGNING_SECRET]: { type: "secret_text", fields: {} },
    [RECEIPT_KEY_ID_BINDING]: {
      type: "plain_text",
      fields: { text: selected.receiptKeyId },
    },
    [AUTHORITY_WORKER_BINDING]: {
      type: "plain_text",
      fields: { text: selected.workerName },
    },
    [AUTHORITY_SOURCE_BINDING]: {
      type: "plain_text",
      fields: { text: identity.commit },
    },
    [AUTHORITY_ARTIFACT_BINDING]: {
      type: "plain_text",
      fields: { text: identity.artifactDigest },
    },
    [VERSION_BINDING]: { type: "version_metadata", fields: {} },
  };
}

/**
 * Owner deploy for the one-method route-less Worker. Status is authoritative
 * Cloudflare readback; apply re-fences that exact state around one upload.
 */
export async function runSponsorshipAuthority(
  invocation: SponsorshipAuthorityDeployInvocation,
  target: DeployTarget,
  options: SponsorshipAuthorityDeployOptions = {},
): Promise<Record<string, unknown>> {
  if (target.environment !== invocation.environment) {
    throw preflightError("sponsorship authority invocation and target differ");
  }
  const selected = requireAuthorityTarget(target);
  const run = options.run ?? runCommand;
  const credential =
    invocation.environment === "integration" &&
    options.state !== undefined &&
    invocation.action === "status"
      ? undefined
      : await resolveCloudflareCredential(invocation.environment, {
          cloudflareEnvironment: options.cloudflareEnvironment,
          run,
        });
  const environment = credential?.childEnvironment ?? {};
  const state =
    options.state ??
    new CloudflareState({
      accountId: target.accountId,
      token: credential?.token ?? exactToken(environment),
    });
  const before = await inspectSponsorshipAuthority("preflight", target, state);

  if (invocation.action === "status") {
    const statusRoot =
      options.database === undefined
        ? mkdtempSync(join(tmpdir(), "takoserver-sponsorship-authority-status-"))
        : undefined;
    try {
      let database = options.database;
      if (database === undefined) {
        if (statusRoot === undefined) {
          throw preflightError("sponsorship authority status workspace is unavailable");
        }
        database = createRemoteSigningDatabase(
          writeSponsorshipAuthorityConfig({
            path: join(statusRoot, "wrangler.jsonc"),
            main: resolve(REPOSITORY, "src/entry-sponsorship-authority-worker.ts"),
            target,
            commit: invocation.commit,
          }),
          environment,
          run,
        );
      }
      const ordinaryRow = await database.readKey(target.signing.currentKeyId, "preflight");
      const nextOrdinaryRow =
        target.signing.nextKeyId === undefined
          ? null
          : await database.readKey(target.signing.nextKeyId, "preflight");
      const credentialRow = await database.readKey(selected.credentialKeyId, "preflight");
      assertDedicatedSponsorshipKeys(target, ordinaryRow, credentialRow, nextOrdinaryRow);
      return {
        kind: "takoserver.sponsorship-authority-worker-status@v1",
        surface: invocation.surface,
        environment: invocation.environment,
        workerName: selected.workerName,
        organizationPinned: true,
        selectedCommit: invocation.commit,
        deployedCommit: before?.commit ?? null,
        commitMatches: before?.commit === invocation.commit,
        deploymentId: before?.history.deploymentId ?? null,
        versionId: before?.history.versionId ?? null,
        previousVersionId: before?.history.previousVersionId ?? null,
        artifactDigest: before?.artifactDigest ?? null,
        scriptEtag: before?.scriptEtag ?? null,
        topologyAudit: before?.topologyAudit ?? null,
        method: "issueTenantRunCredential",
        maximumCredentialLifetimeSeconds: 300,
        routeMode: "service-binding-rpc-only",
        bindingClosure: "exact-d1-and-dedicated-sponsorship-keys",
        credentialKeyId: selected.credentialKeyId,
        credentialPublicJwk: selected.credentialPublicJwk,
        credentialPublicJwkSha256: sha256(canonicalJson(selected.credentialPublicJwk)),
        credentialPublicKeyRegistered: credentialRow !== null,
        receiptKeyId: selected.receiptKeyId,
        receiptPublicJwk: selected.receiptPublicJwk,
        receiptPublicJwkSha256: sha256(canonicalJson(selected.receiptPublicJwk)),
        closureReady: before?.commit === invocation.commit && credentialRow !== null,
        functionalProofPending: true,
        rolloutReady: false,
        nextStep:
          "release Hosted with the exact service binding, then run the authenticated staging credential E2E",
      };
    } finally {
      if (statusRoot !== undefined) rmSync(statusRoot, { recursive: true, force: true });
    }
  }

  const source = await qualifySource({
    environment: invocation.environment,
    commit: invocation.commit,
    run,
  });
  const reviewer = exactReviewer(
    options.review ?? requireEnvironment("TAKOSERVER_INDEPENDENT_REVIEW"),
  );
  await checked(run, "sponsorship authority owner gate", ["bun", "run", "check"]);

  const temporary = options.outputDirectory === undefined;
  const root =
    options.outputDirectory ?? mkdtempSync(join(tmpdir(), "takoserver-sponsorship-authority-"));
  mkdirSync(root, { recursive: true, mode: 0o700 });
  try {
    const prepared = await prepareWorkerArtifact({
      root,
      target,
      commit: source.commit,
      main: resolve(REPOSITORY, "src/entry-sponsorship-authority-worker.ts"),
      writeConfig: ({ path, main, bundleDigestHex }) =>
        writeSponsorshipAuthorityConfig({
          path,
          main,
          target,
          commit: source.commit,
          ...(bundleDigestHex === undefined ? {} : { artifactDigest: `sha256:${bundleDigestHex}` }),
        }),
      run,
      environment,
    });
    const artifactDigest = `sha256:${prepared.bundleDigestHex}` as const;
    const database =
      options.database ?? createRemoteSigningDatabase(prepared.configPath, environment, run);
    const signingRow = await database.readKey(target.signing.currentKeyId, "preflight");
    const nextSigningRow =
      target.signing.nextKeyId === undefined
        ? null
        : await database.readKey(target.signing.nextKeyId, "preflight");
    const credentialRowBefore = await database.readKey(selected.credentialKeyId, "preflight");
    assertDedicatedSponsorshipKeys(target, signingRow, credentialRowBefore, nextSigningRow);
    if (
      credentialRowBefore !== null &&
      before?.commit === source.commit &&
      before.artifactDigest === artifactDigest
    ) {
      throw preflightError(
        "sponsorship authority and credential key already serve the selected identity; use --status",
      );
    }
    const signingJwk = await readVerifiedPrivateSigningJwk(
      options.privateJwkPath ??
        requireEnvironment("TAKOSERVER_SPONSORSHIP_CREDENTIAL_PRIVATE_JWK_PATH"),
      targetCredentialRow(target),
      selected.credentialKeyId,
    );
    const receiptSigningJwk = await readVerifiedPrivateSigningJwk(
      options.receiptPrivateJwkPath ??
        requireEnvironment("TAKOSERVER_SPONSORSHIP_RECEIPT_PRIVATE_JWK_PATH"),
      {
        keyId: selected.receiptKeyId,
        publicJwk: JSON.stringify(selected.receiptPublicJwk),
        createdAtEpochSeconds: 0,
        revokedAtEpochSeconds: null,
      },
      selected.receiptKeyId,
    );
    const secretsPath = join(prepared.releaseDirectory, "secrets.json");
    writeFileSync(
      secretsPath,
      `${JSON.stringify({
        [CREDENTIAL_SIGNING_SECRET]: signingJwk,
        [RECEIPT_SIGNING_SECRET]: receiptSigningJwk,
      })}\n`,
      {
        mode: 0o600,
      },
    );
    const sealed = prepared.seal(["secrets.json"]);
    sealed.assertUnchanged();

    const last = await inspectSponsorshipAuthority("preflight", target, state);
    assertSameInspection(before, last);
    await registerSponsorshipCredentialPublicKey(target, database);
    const upload = await run(
      wranglerCommand([
        "deploy",
        prepared.bundlePath,
        "--no-bundle",
        "--config",
        prepared.configPath,
        "--strict",
        "--secrets-file",
        secretsPath,
        "--message",
        authorityMessage(source.commit, artifactDigest),
      ]),
      { env: environment },
    );
    if (upload.exitCode !== 0) {
      throw mutationError(
        "sponsorship authority upload acknowledgement is indeterminate; do not retry before --status",
        `exit=${upload.exitCode}`,
      );
    }

    const after = await inspectSponsorshipAuthority("verification", target, state);
    if (
      after === null ||
      after.history.versionId === before?.history.versionId ||
      (before !== null && after.history.previousVersionId !== before.history.versionId) ||
      after.commit !== source.commit ||
      after.artifactDigest !== artifactDigest
    ) {
      throw verificationError(
        "sponsorship authority readback does not identify the exact uploaded successor",
      );
    }
    return {
      kind: "takoserver.sponsorship-authority-worker-apply@v1",
      surface: invocation.surface,
      environment: invocation.environment,
      workerName: selected.workerName,
      commit: source.commit,
      dirty: source.dirty,
      remoteRef: source.remoteRef,
      reviewer,
      organizationPinned: true,
      method: "issueTenantRunCredential",
      maximumCredentialLifetimeSeconds: 300,
      routeMode: "service-binding-rpc-only",
      bindingClosure: "exact-d1-and-dedicated-sponsorship-keys",
      credentialKeyId: selected.credentialKeyId,
      credentialPublicJwk: selected.credentialPublicJwk,
      credentialPublicJwkSha256: sha256(canonicalJson(selected.credentialPublicJwk)),
      credentialPublicKeyRegistered: true,
      receiptKeyId: selected.receiptKeyId,
      receiptPublicJwk: selected.receiptPublicJwk,
      receiptPublicJwkSha256: sha256(canonicalJson(selected.receiptPublicJwk)),
      artifactDigest,
      scriptEtag: after.scriptEtag,
      topologyAudit: after.topologyAudit,
      artifactBytes: sealed.bytes,
      artifactFiles: sealed.files,
      previousVersionId: before?.history.versionId ?? null,
      deploymentId: after.history.deploymentId,
      versionId: after.history.versionId,
      closureReady: true,
      functionalProofPending: true,
      rolloutReady: false,
      nextStep:
        "release Hosted with the exact service binding, then run the authenticated staging credential E2E",
      rollback:
        before === null
          ? "forward repair only: no previous sponsorship authority Version exists"
          : `wrangler versions deploy ${before.history.versionId}@100% --yes --name ${selected.workerName}`,
    };
  } finally {
    unsealDirectory(root);
    if (temporary) rmSync(root, { recursive: true, force: true });
  }
}

export async function inspectSponsorshipAuthority(
  phase: DeployPhase,
  target: DeployTarget,
  state: SponsorshipAuthorityDeployState,
): Promise<SponsorshipAuthorityInspection | null> {
  const selected = requireAuthorityTarget(target);
  const scripts = await state.workerScripts();
  if (scripts.length !== new Set(scripts).size) {
    throw phaseError(phase, "Worker script inventory contains duplicates");
  }
  const topologyAudit = await state.workerTopologyAudit();
  const domains = (await state.workerDomains()).filter(
    ({ service }) => service === selected.workerName,
  );
  const routes = (await state.workerRoutes()).filter(
    ({ script }) => script === selected.workerName,
  );
  if (domains.length !== 0 || routes.length !== 0) {
    throw phaseError(phase, "sponsorship authority unexpectedly owns a public domain or route");
  }
  if (!scripts.includes(selected.workerName)) return null;
  const history = parseWorkerDeploymentHistory(
    await state.workerDeployments(selected.workerName),
    phase,
  );
  if (history === null) {
    throw phaseError(phase, "sponsorship authority has no served deployment");
  }
  const version = await state.workerVersion(selected.workerName, history.versionId);
  const identity = authorityIdentity(phase, history.versionId, version);
  const scriptEtag = workerVersionScriptContentIdentity(phase, history.versionId, version);
  assertExactVersionBindingClosure(
    phase,
    history.versionId,
    version,
    sponsorshipAuthorityBindingClosure(target, identity),
  );
  assertExactSecretInventory(
    await state.workerSecrets(selected.workerName),
    [CREDENTIAL_SIGNING_SECRET, RECEIPT_SIGNING_SECRET],
    phase,
  );
  const subdomain = await state.workerSubdomain(selected.workerName);
  if (subdomain.enabled || subdomain.previewsEnabled) {
    throw phaseError(phase, "sponsorship authority has workers.dev or preview URLs enabled");
  }
  return { history, ...identity, scriptEtag, topologyAudit };
}

function targetCredentialRow(target: DeployTarget): SigningPublicKeyRow {
  const selected = requireAuthorityTarget(target);
  return {
    keyId: selected.credentialKeyId,
    publicJwk: JSON.stringify(selected.credentialPublicJwk),
    createdAtEpochSeconds: 0,
    revokedAtEpochSeconds: null,
  };
}

function sha256(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const item = value as Record<string, unknown>;
  return `{${Object.keys(item)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(item[key])}`)
    .join(",")}}`;
}

function authorityIdentity(
  phase: DeployPhase,
  versionId: string,
  value: unknown,
): { readonly commit: string; readonly artifactDigest: `sha256:${string}` } {
  if (
    !isRecord(value) ||
    !isRecord(value.annotations) ||
    !exactKeys(value.annotations, ["workers/message", "workers/triggered_by"]) ||
    value.annotations["workers/triggered_by"] !== "version_upload"
  ) {
    throw phaseError(phase, "sponsorship authority has no canonical identity");
  }
  const message = value.annotations["workers/message"];
  const match =
    typeof message === "string"
      ? /^sponsorship-authority:([0-9a-f]{40}):(sha256:[0-9a-f]{64})$/u.exec(message)
      : null;
  if (!match?.[1] || !match[2]) {
    throw phaseError(phase, `sponsorship authority Version ${versionId} identity is invalid`);
  }
  return {
    commit: match[1],
    artifactDigest: match[2] as `sha256:${string}`,
  };
}

function authorityMessage(commit: string, artifactDigest: `sha256:${string}`): string {
  return `sponsorship-authority:${commit}:${artifactDigest}`;
}

function requireAuthorityTarget(
  target: DeployTarget,
): NonNullable<DeployTarget["sponsorshipAuthority"]> {
  if (target.sponsorshipAuthority === undefined) {
    throw preflightError("deploy target does not configure the sponsorship authority Worker");
  }
  return target.sponsorshipAuthority;
}

function assertSameInspection(
  before: SponsorshipAuthorityInspection | null,
  after: SponsorshipAuthorityInspection | null,
): void {
  if (
    (before === null) !== (after === null) ||
    (before !== null &&
      after !== null &&
      (before.history.deploymentId !== after.history.deploymentId ||
        before.history.versionId !== after.history.versionId ||
        before.history.previousVersionId !== after.history.previousVersionId ||
        before.commit !== after.commit ||
        before.artifactDigest !== after.artifactDigest ||
        before.scriptEtag !== after.scriptEtag ||
        canonicalJson(before.topologyAudit) !== canonicalJson(after.topologyAudit)))
  ) {
    throw preflightError("sponsorship authority changed during deploy qualification");
  }
}

async function checked(
  run: SponsorshipAuthorityDeployProcess,
  description: string,
  command: readonly string[],
): Promise<void> {
  const result = await run(command);
  if (result.exitCode !== 0) {
    throw preflightError(`${description} failed (exit ${result.exitCode})`);
  }
}

function exactReviewer(value: string): string {
  if (value.trim() !== value || value.length < 1 || value.length > 256 || value.includes("\n")) {
    throw preflightError("TAKOSERVER_INDEPENDENT_REVIEW must name one reviewer");
  }
  return value;
}

function exactToken(environment: Readonly<Record<string, string>>): string {
  const value = environment.CLOUDFLARE_API_TOKEN;
  if (!value) throw preflightError("CLOUDFLARE_API_TOKEN is required");
  return value;
}

function phaseError(phase: DeployPhase, message: string): DeployError {
  return phase === "preflight"
    ? preflightError(message)
    : phase === "mutation"
      ? mutationError(message)
      : verificationError(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}
