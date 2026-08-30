import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  INTEGRATION_E2E_API_KEY_DEFAULT_TTL_SECONDS,
  INTEGRATION_E2E_API_KEY_NAME,
  INTEGRATION_E2E_API_KEY_SCOPES,
  INTEGRATION_E2E_ORGANIZATION_ID,
} from "../../src/integration-e2e-credential-authority.ts";
import {
  AUTHORITY_CONFIG_ENVIRONMENT_VARIABLE,
  OUTPUT_DIRECTORY_ENVIRONMENT_VARIABLE,
  PRIVATE_JWK_ENVIRONMENT_VARIABLE,
  TARGET_ENVIRONMENT_VARIABLE,
} from "../integration-e2e-credentials.ts";
import { CloudflareState } from "./cloudflare-state.ts";
import { mutationError, preflightError } from "./errors.ts";
import {
  type CommandResult,
  cloudflareChildEnvironment,
  REPOSITORY,
  requireEnvironment,
  runCommand,
} from "./process.ts";
import type { DeployEnvironment } from "./qualification.ts";
import { writeWorkerConfig } from "./realized-config.ts";
import {
  activePublicJwk,
  createRemoteSigningDatabase,
  type SigningDatabase,
  type SigningPublicKeyRow,
} from "./signing.ts";
import type { DeployTarget } from "./target.ts";
import {
  inspectLiveWorkerVersion,
  type LiveWorkerVersion,
  type WorkerState,
} from "./worker-live.ts";

export type IntegrationE2eCredentialAction = "issue" | "status" | "revoke";

export interface IntegrationE2eCredentialInvocation {
  readonly surface: "takoserver-integration-e2e-credentials";
  readonly action: IntegrationE2eCredentialAction;
  readonly environment: DeployEnvironment;
  readonly commit: string;
}

export type IntegrationE2eCredentialProcess = (
  command: readonly string[],
  options?: { readonly env?: Readonly<Record<string, string>>; readonly input?: string },
) => Promise<CommandResult>;

export interface IntegrationE2eCredentialOptions {
  readonly state?: WorkerState;
  readonly run?: IntegrationE2eCredentialProcess;
  readonly cloudflareEnvironment?: Readonly<Record<string, string>>;
  readonly privateJwkPath?: string;
  readonly credentialOutputDirectory?: string;
  readonly temporaryDirectory?: string;
  readonly review?: string;
  /** Authoritative active runtime-signing identity; injectable only for portable tests. */
  readonly signingDatabase?: Pick<SigningDatabase, "readKey">;
}

/**
 * Invokes the offline helper only after the immutable live Worker proves its
 * exact target, source, artifact, Version, and dedicated public key closure.
 * The private JWK remains a path in a sanitized child environment; neither its
 * bytes nor the issued API-key secret cross argv/stdout.
 */
export async function runIntegrationE2eCredentials(
  invocation: IntegrationE2eCredentialInvocation,
  target: DeployTarget,
  options: IntegrationE2eCredentialOptions = {},
): Promise<Record<string, unknown>> {
  assertIntegrationInvocation(invocation, target);
  const authority = exactTargetAuthority(target);
  const environment =
    options.cloudflareEnvironment ??
    (options.state !== undefined && options.signingDatabase !== undefined
      ? {}
      : cloudflareChildEnvironment());
  const run = options.run ?? runCommand;
  const state =
    options.state ??
    new CloudflareState({
      accountId: target.accountId,
      token: exactCloudflareToken(environment),
    });
  const temporary = options.temporaryDirectory === undefined;
  const root =
    options.temporaryDirectory ?? mkdtempSync(join(tmpdir(), "takoserver-integration-e2e-"));
  mkdirSync(root, { recursive: true, mode: 0o700 });

  try {
    const inspectionConfig = writeWorkerConfig(target, {
      path: join(root, "inspect-wrangler.jsonc"),
      main: resolve(REPOSITORY, "src/entry-cloudflare-worker.ts"),
      commit: invocation.commit,
      signingKeyId: target.signing.currentKeyId,
      omitIntegrationE2eCredentialAuthority: true,
    });
    const signingDatabase =
      options.signingDatabase ?? createRemoteSigningDatabase(inspectionConfig, environment, run);
    const signingIdentity = await requireDistinctRuntimeSigningIdentity(
      target,
      authority.publicJwk.x,
      signingDatabase,
    );
    const live = await inspectLiveWorkerVersion("preflight", target, state, {});
    assertSelectedLiveCommit(invocation.commit, live);

    const reviewer =
      invocation.action === "status"
        ? undefined
        : exactReviewer(options.review ?? requireEnvironment("TAKOSERVER_INDEPENDENT_REVIEW"));
    const privateJwkPath =
      options.privateJwkPath ?? requireEnvironment(PRIVATE_JWK_ENVIRONMENT_VARIABLE);
    const credentialOutputDirectory =
      options.credentialOutputDirectory ??
      requireEnvironment(OUTPUT_DIRECTORY_ENVIRONMENT_VARIABLE);
    const snapshotPath = join(root, "deploy-target.json");
    writeFileSync(snapshotPath, `${JSON.stringify(target, null, 2)}\n`, {
      mode: 0o600,
      flag: "wx",
    });
    const exactLive =
      invocation.action === "status"
        ? live
        : await inspectLiveWorkerVersion("preflight", target, state, {});
    assertSameLiveVersion(live, exactLive);
    if (invocation.action !== "status") {
      const lastSigningIdentity = await requireDistinctRuntimeSigningIdentity(
        target,
        authority.publicJwk.x,
        signingDatabase,
      );
      if (!sameSigningIdentity(signingIdentity, lastSigningIdentity)) {
        throw preflightError(
          "active runtime signing identity changed before credential helper invocation",
        );
      }
    }
    const authorityConfig = {
      environment: "integration" as const,
      organizationId: authority.organizationId,
      publicJwk: authority.publicJwk,
      sourceCommit: exactLive.commit,
      artifactDigest: `sha256:${exactLive.bundleDigestHex}` as const,
      publicWorkerVersionId: exactLive.history.versionId,
    };
    const child = await run(
      ["bun", resolve(REPOSITORY, "scripts/integration-e2e-credentials.ts"), invocation.action],
      {
        env: {
          [TARGET_ENVIRONMENT_VARIABLE]: snapshotPath,
          [PRIVATE_JWK_ENVIRONMENT_VARIABLE]: privateJwkPath,
          [OUTPUT_DIRECTORY_ENVIRONMENT_VARIABLE]: credentialOutputDirectory,
          [AUTHORITY_CONFIG_ENVIRONMENT_VARIABLE]: JSON.stringify(authorityConfig),
        },
      },
    );
    if (child.exitCode !== 0) {
      const detail = childDiagnostics(child);
      if (invocation.action === "status") {
        throw preflightError("integration E2E credential status failed", detail);
      }
      throw mutationError(
        `integration E2E credential ${invocation.action} is indeterminate; do not retry before status`,
        detail,
      );
    }
    const result = exactHelperResult(invocation.action, child.stdout, authorityConfig);
    return {
      kind: "takoserver.integration-e2e-credential-invocation@v1",
      surface: invocation.surface,
      action: invocation.action,
      environment: "integration",
      selectedCommit: invocation.commit,
      deployedCommit: exactLive.commit,
      artifactDigest: authorityConfig.artifactDigest,
      publicWorkerVersionId: exactLive.history.versionId,
      organizationId: authority.organizationId,
      ...(reviewer === undefined ? {} : { reviewer }),
      credentialsRedacted: true,
      result,
    };
  } finally {
    if (temporary) rmSync(root, { recursive: true, force: true });
  }
}

async function requireDistinctRuntimeSigningIdentity(
  target: DeployTarget,
  authorityPublicX: string,
  database: Pick<SigningDatabase, "readKey">,
): Promise<SigningPublicKeyRow> {
  const keyId = target.signing.currentKeyId;
  const row = await database.readKey(keyId, "preflight");
  const signingPublicJwk = activePublicJwk(row, keyId);
  if (signingPublicJwk.x === authorityPublicX) {
    throw preflightError(
      "integration E2E credential authority must not reuse the active runtime signing key",
    );
  }
  if (row === null) throw preflightError("active runtime signing identity is unavailable");
  return row;
}

function sameSigningIdentity(expected: SigningPublicKeyRow, actual: SigningPublicKeyRow): boolean {
  return (
    actual.keyId === expected.keyId &&
    actual.publicJwk === expected.publicJwk &&
    actual.createdAtEpochSeconds === expected.createdAtEpochSeconds &&
    actual.revokedAtEpochSeconds === expected.revokedAtEpochSeconds
  );
}

function assertIntegrationInvocation(
  invocation: IntegrationE2eCredentialInvocation,
  target: DeployTarget,
): void {
  if (invocation.environment !== "integration" || target.environment !== "integration") {
    throw preflightError("integration E2E credential surface is integration-only");
  }
  if (target.environment !== invocation.environment) {
    throw preflightError("integration E2E credential invocation and target environments differ");
  }
}

function exactTargetAuthority(
  target: DeployTarget,
): NonNullable<DeployTarget["integrationE2eCredentialAuthority"]> {
  const authority = target.integrationE2eCredentialAuthority;
  if (!authority || authority.organizationId !== INTEGRATION_E2E_ORGANIZATION_ID) {
    throw preflightError(
      `integration E2E credential target must name exact organization ${INTEGRATION_E2E_ORGANIZATION_ID}`,
    );
  }
  for (const other of [
    target.operatorIdentity?.publicJwk,
    target.formAuthority?.operatorPublicJwk,
  ]) {
    if (other?.x === authority.publicJwk.x) {
      throw preflightError("integration E2E credential authority public key is reused");
    }
  }
  return authority;
}

function assertSelectedLiveCommit(selectedCommit: string, live: LiveWorkerVersion): void {
  if (live.commit !== selectedCommit) {
    throw preflightError(
      "integration E2E credential action requires the selected commit to be the exact live Worker commit",
      `selected=${selectedCommit} live=${live.commit}`,
    );
  }
}

function assertSameLiveVersion(before: LiveWorkerVersion, after: LiveWorkerVersion): void {
  if (
    after.history.deploymentId !== before.history.deploymentId ||
    after.history.versionId !== before.history.versionId ||
    after.history.previousVersionId !== before.history.previousVersionId ||
    after.commit !== before.commit ||
    after.bundleDigestHex !== before.bundleDigestHex
  ) {
    throw preflightError("live Worker provenance changed before credential helper invocation");
  }
}

function exactHelperResult(
  action: IntegrationE2eCredentialAction,
  stdout: string,
  authority: {
    readonly organizationId: string;
    readonly sourceCommit: string;
    readonly artifactDigest: string;
    readonly publicWorkerVersionId: string;
  },
): Record<string, unknown> {
  if (new TextEncoder().encode(stdout).byteLength > 256 * 1_024) {
    throw mutationError("integration E2E credential helper output exceeded its bound");
  }
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    throw mutationError("integration E2E credential helper returned invalid JSON");
  }
  if (!isRecord(value)) {
    throw mutationError("integration E2E credential helper returned an invalid result");
  }
  if (action === "issue") {
    const key = value.key;
    if (
      value.kind !== "takoserver.integration-e2e-credential@v2" ||
      value.environment !== "integration" ||
      value.organizationId !== authority.organizationId ||
      value.sourceCommit !== authority.sourceCommit ||
      value.artifactDigest !== authority.artifactDigest ||
      value.publicWorkerVersionId !== authority.publicWorkerVersionId ||
      !isRecord(key) ||
      key.name !== INTEGRATION_E2E_API_KEY_NAME ||
      typeof key.keyId !== "string" ||
      typeof key.operationId !== "string" ||
      !Array.isArray(key.scopes) ||
      JSON.stringify(key.scopes) !== JSON.stringify(INTEGRATION_E2E_API_KEY_SCOPES) ||
      key.ttlSeconds !== INTEGRATION_E2E_API_KEY_DEFAULT_TTL_SECONDS ||
      typeof key.createdAt !== "string" ||
      typeof key.expiresAt !== "string" ||
      typeof key.secretPath !== "string"
    ) {
      throw mutationError("integration E2E credential issue returned mismatched provenance");
    }
    return {
      kind: value.kind,
      environment: value.environment,
      organizationId: value.organizationId,
      sourceCommit: value.sourceCommit,
      artifactDigest: value.artifactDigest,
      publicWorkerVersionId: value.publicWorkerVersionId,
      key: {
        name: key.name,
        keyId: key.keyId,
        operationId: key.operationId,
        scopes: [...key.scopes],
        ttlSeconds: key.ttlSeconds,
        createdAt: key.createdAt,
        expiresAt: key.expiresAt,
        secretPath: key.secretPath,
      },
    };
  } else if (action === "status") {
    const files = value.files;
    if (
      value.kind !== "takoserver.integration-e2e-credential-status@v2" ||
      value.organizationId !== authority.organizationId ||
      typeof value.keyId !== "string" ||
      !isRecord(files)
    ) {
      throw preflightError("integration E2E credential status returned a mismatched result");
    }
    const remote = safeRemoteStatus(value.remote, authority.organizationId);
    return {
      kind: value.kind,
      organizationId: value.organizationId,
      keyId: value.keyId,
      remote,
      files: {
        secret: safeLocalFileStatus(files.secret),
        metadata: safeLocalFileStatus(files.metadata),
      },
    };
  }
  if (
    value.organizationId !== authority.organizationId ||
    value.absent !== true ||
    typeof value.keyId !== "string"
  ) {
    throw mutationError("integration E2E credential revoke returned a mismatched result");
  }
  return {
    organizationId: value.organizationId,
    keyId: value.keyId,
    absent: true,
  };
}

function safeRemoteStatus(value: unknown, organizationId: string): Record<string, unknown> | null {
  if (value === null) return null;
  if (
    !isRecord(value) ||
    typeof value.keyId !== "string" ||
    typeof value.operationId !== "string" ||
    typeof value.present !== "boolean" ||
    typeof value.usable !== "boolean" ||
    (value.organizationId !== undefined && value.organizationId !== organizationId) ||
    (value.scopes !== undefined &&
      (!Array.isArray(value.scopes) ||
        JSON.stringify(value.scopes) !== JSON.stringify(INTEGRATION_E2E_API_KEY_SCOPES))) ||
    (value.createdAt !== undefined && typeof value.createdAt !== "string") ||
    (value.expiresAt !== undefined && typeof value.expiresAt !== "string")
  ) {
    throw preflightError("integration E2E credential status returned a mismatched result");
  }
  return {
    keyId: value.keyId,
    operationId: value.operationId,
    present: value.present,
    usable: value.usable,
    ...(value.organizationId === undefined ? {} : { organizationId: value.organizationId }),
    ...(value.scopes === undefined ? {} : { scopes: [...value.scopes] }),
    ...(value.createdAt === undefined ? {} : { createdAt: value.createdAt }),
    ...(value.expiresAt === undefined ? {} : { expiresAt: value.expiresAt }),
  };
}

function safeLocalFileStatus(value: unknown): Record<string, unknown> {
  if (
    !isRecord(value) ||
    typeof value.path !== "string" ||
    typeof value.exists !== "boolean" ||
    (value.mode !== null && !Number.isSafeInteger(value.mode)) ||
    typeof value.symlink !== "boolean"
  ) {
    throw preflightError("integration E2E credential status returned invalid local custody");
  }
  return { path: value.path, exists: value.exists, mode: value.mode, symlink: value.symlink };
}

function childDiagnostics(result: CommandResult): string {
  return (
    `helper_exit=${result.exitCode} ` +
    `stdout_bytes=${new TextEncoder().encode(result.stdout).byteLength} ` +
    `stderr_bytes=${new TextEncoder().encode(result.stderr).byteLength}`
  );
}

function exactReviewer(value: string): string {
  if (value.trim() !== value || value.length < 1 || value.length > 256 || value.includes("\n")) {
    throw preflightError("TAKOSERVER_INDEPENDENT_REVIEW must name one reviewer");
  }
  return value;
}

function exactCloudflareToken(environment: Readonly<Record<string, string>>): string {
  const token = environment.CLOUDFLARE_API_TOKEN;
  if (!token) throw preflightError("CLOUDFLARE_API_TOKEN is required");
  return token;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
