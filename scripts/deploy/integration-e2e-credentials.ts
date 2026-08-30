import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  INTEGRATION_E2E_API_KEY_DEFAULT_TTL_SECONDS,
  INTEGRATION_E2E_EVIDENCE_KEY_NAME,
  INTEGRATION_E2E_EVIDENCE_SCOPES,
  INTEGRATION_E2E_ORGANIZATION_ID,
  INTEGRATION_E2E_WRITER_KEY_NAME,
  INTEGRATION_E2E_WRITER_SCOPES,
} from "../../src/integration-e2e-credential-authority.ts";
import { parseStrictJson } from "../../src/strict-json.ts";
import {
  AUTHORITY_CONFIG_ENVIRONMENT_VARIABLE,
  credentialPaths,
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
 * bytes nor either issued API-key secret cross argv/stdout.
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
    const result = exactHelperResult(
      invocation.action,
      child.stdout,
      authorityConfig,
      target.publicOrigin,
      credentialPaths(credentialOutputDirectory),
    );
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
  origin: string,
  paths: ReturnType<typeof credentialPaths>,
): Record<string, unknown> {
  if (new TextEncoder().encode(stdout).byteLength > 256 * 1_024) {
    throw mutationError("integration E2E credential helper output exceeded its bound");
  }
  let value: unknown;
  try {
    value = parseStrictJson(new TextEncoder().encode(stdout), 256 * 1_024);
  } catch {
    throw mutationError("integration E2E credential helper returned invalid JSON");
  }
  if (!isRecord(value)) {
    throw mutationError("integration E2E credential helper returned an invalid result");
  }
  if (action === "issue") {
    const requestedAuthority = value.requestedAuthority;
    const roles = value.roles;
    if (
      !exactKeys(value, [
        "environment",
        "kind",
        "operationId",
        "organizationId",
        "origin",
        "requestedAuthority",
        "roles",
        "ttlSeconds",
        "version",
      ]) ||
      !isRecord(requestedAuthority) ||
      !exactKeys(requestedAuthority, ["artifactDigest", "publicWorkerVersionId", "sourceCommit"]) ||
      !isRecord(roles) ||
      !exactKeys(roles, ["evidence", "writer"])
    ) {
      throw mutationError("integration E2E credential helper returned an invalid result");
    }
    if (
      value.kind !== "takoserver.integration-e2e-credential-pair@v3" ||
      value.version !== 3 ||
      value.origin !== origin ||
      value.environment !== "integration" ||
      value.organizationId !== authority.organizationId ||
      typeof value.operationId !== "string" ||
      value.ttlSeconds !== INTEGRATION_E2E_API_KEY_DEFAULT_TTL_SECONDS ||
      requestedAuthority.sourceCommit !== authority.sourceCommit ||
      requestedAuthority.artifactDigest !== authority.artifactDigest ||
      requestedAuthority.publicWorkerVersionId !== authority.publicWorkerVersionId
    ) {
      throw mutationError("integration E2E credential issue returned mismatched provenance");
    }
    const writer = safeIssueRole(roles.writer, "writer");
    const evidence = safeIssueRole(roles.evidence, "evidence");
    if (
      writer.keyId === evidence.keyId ||
      writer.secretPath !== paths.writerSecret ||
      evidence.secretPath !== paths.evidenceSecret
    ) {
      throw mutationError("integration E2E credential issue returned non-distinct role custody");
    }
    return {
      kind: value.kind,
      version: value.version,
      environment: value.environment,
      organizationId: value.organizationId,
      operationId: value.operationId,
      ttlSeconds: value.ttlSeconds,
      requestedAuthority: {
        sourceCommit: requestedAuthority.sourceCommit,
        artifactDigest: requestedAuthority.artifactDigest,
        publicWorkerVersionId: requestedAuthority.publicWorkerVersionId,
      },
      roles: { writer, evidence },
    };
  } else if (action === "status") {
    const files = value.files;
    if (
      !exactKeys(value, ["files", "kind", "operationId", "organizationId", "origin", "remote"]) ||
      value.kind !== "takoserver.integration-e2e-credential-pair-local-status@v3" ||
      value.origin !== origin ||
      value.organizationId !== authority.organizationId ||
      typeof value.operationId !== "string" ||
      !isRecord(files) ||
      !exactKeys(files, ["evidenceSecret", "metadata", "writerSecret"])
    ) {
      throw preflightError("integration E2E credential status returned a mismatched result");
    }
    const remote = safeRemoteStatus(value.remote, authority.organizationId);
    const writerSecret = safeLocalFileStatus(files.writerSecret, paths.writerSecret);
    const evidenceSecret = safeLocalFileStatus(files.evidenceSecret, paths.evidenceSecret);
    const metadata = safeLocalFileStatus(files.metadata, paths.metadata);
    if (
      (remote === null && value.operationId !== "") ||
      (remote !== null && remote.operationId !== value.operationId)
    ) {
      throw preflightError(
        "integration E2E credential status returned mismatched recovery custody",
      );
    }
    return {
      kind: value.kind,
      organizationId: value.organizationId,
      operationId: value.operationId,
      remote,
      files: { writerSecret, evidenceSecret, metadata },
    };
  }
  if (
    !exactKeys(value, ["absent", "keyIds", "operationId", "organizationId"]) ||
    value.organizationId !== authority.organizationId ||
    value.absent !== true ||
    typeof value.operationId !== "string" ||
    !isRecord(value.keyIds) ||
    !exactKeys(value.keyIds, ["evidence", "writer"]) ||
    typeof value.keyIds.writer !== "string" ||
    typeof value.keyIds.evidence !== "string" ||
    value.keyIds.writer === value.keyIds.evidence
  ) {
    throw mutationError("integration E2E credential revoke returned a mismatched result");
  }
  return {
    organizationId: value.organizationId,
    operationId: value.operationId,
    keyIds: { writer: value.keyIds.writer, evidence: value.keyIds.evidence },
    absent: true,
  };
}

function safeIssueRole(value: unknown, role: "writer" | "evidence"): Record<string, unknown> {
  const name =
    role === "writer" ? INTEGRATION_E2E_WRITER_KEY_NAME : INTEGRATION_E2E_EVIDENCE_KEY_NAME;
  const scopes =
    role === "writer" ? INTEGRATION_E2E_WRITER_SCOPES : INTEGRATION_E2E_EVIDENCE_SCOPES;
  if (
    !isRecord(value) ||
    !exactKeys(value, ["keyId", "name", "role", "scopes", "secretPath"]) ||
    value.role !== role ||
    value.name !== name ||
    typeof value.keyId !== "string" ||
    JSON.stringify(value.scopes) !== JSON.stringify(scopes) ||
    typeof value.secretPath !== "string"
  ) {
    throw mutationError("integration E2E credential issue returned invalid role metadata");
  }
  return { role, name, keyId: value.keyId, scopes: [...scopes], secretPath: value.secretPath };
}

function safeRemoteStatus(value: unknown, organizationId: string): Record<string, unknown> | null {
  if (value === null) return null;
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      "completeness",
      "fence",
      "kind",
      "legacyKeyPresent",
      "operationId",
      "organizationId",
      "provenance",
      "roles",
      "state",
      "terminal",
    ]) ||
    value.kind !== "takoserver.integration-e2e-credential-pair-status@v1" ||
    typeof value.operationId !== "string" ||
    value.organizationId !== organizationId ||
    ![
      "unregistered",
      "indeterminate",
      "prepared",
      "issuing",
      "active",
      "partial",
      "revoking",
      "revoked",
    ].includes(String(value.state)) ||
    (value.fence !== null && (!Number.isSafeInteger(value.fence) || Number(value.fence) < 1)) ||
    !["absent", "partial", "complete"].includes(String(value.completeness)) ||
    typeof value.terminal !== "boolean" ||
    typeof value.legacyKeyPresent !== "boolean" ||
    !isRecord(value.roles) ||
    !exactKeys(value.roles, ["evidence", "writer"])
  ) {
    throw preflightError("integration E2E credential status returned a mismatched result");
  }
  const writer = safeRemoteRole(value.roles.writer, "writer");
  const evidence = safeRemoteRole(value.roles.evidence, "evidence");
  let provenance: Record<string, unknown> | null = null;
  if (value.provenance !== null) {
    if (
      !isRecord(value.provenance) ||
      !exactKeys(value.provenance, ["artifactDigest", "publicWorkerVersionId", "sourceCommit"]) ||
      typeof value.provenance.sourceCommit !== "string" ||
      typeof value.provenance.artifactDigest !== "string" ||
      typeof value.provenance.publicWorkerVersionId !== "string"
    ) {
      throw preflightError("integration E2E credential status returned invalid provenance");
    }
    provenance = {
      sourceCommit: value.provenance.sourceCommit,
      artifactDigest: value.provenance.artifactDigest,
      publicWorkerVersionId: value.provenance.publicWorkerVersionId,
    };
  }
  const complete =
    writer.present && evidence.present
      ? "complete"
      : writer.present || evidence.present
        ? "partial"
        : "absent";
  const durable = ["prepared", "issuing", "active", "partial", "revoking", "revoked"].includes(
    String(value.state),
  );
  const terminal =
    value.state === "revoked" && complete === "absent" && value.legacyKeyPresent === false;
  if (
    value.completeness !== complete ||
    value.terminal !== terminal ||
    (durable && (value.fence === null || provenance === null)) ||
    (!durable && (value.fence !== null || provenance !== null))
  ) {
    throw preflightError("integration E2E credential status returned invalid lifecycle invariants");
  }
  return {
    operationId: value.operationId,
    organizationId,
    state: value.state,
    fence: value.fence,
    completeness: value.completeness,
    terminal: value.terminal,
    legacyKeyPresent: value.legacyKeyPresent,
    provenance,
    roles: { writer, evidence },
  };
}

function safeRemoteRole(value: unknown, role: "writer" | "evidence"): Record<string, unknown> {
  const name =
    role === "writer" ? INTEGRATION_E2E_WRITER_KEY_NAME : INTEGRATION_E2E_EVIDENCE_KEY_NAME;
  const scopes =
    role === "writer" ? INTEGRATION_E2E_WRITER_SCOPES : INTEGRATION_E2E_EVIDENCE_SCOPES;
  const hasTimes = isRecord(value) && ("createdAt" in value || "expiresAt" in value);
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      "keyId",
      "name",
      "present",
      "recorded",
      "role",
      "scopes",
      "ttlSeconds",
      "usable",
      ...(hasTimes ? ["createdAt", "expiresAt"] : []),
    ]) ||
    value.role !== role ||
    value.name !== name ||
    typeof value.keyId !== "string" ||
    JSON.stringify(value.scopes) !== JSON.stringify(scopes) ||
    value.ttlSeconds !== INTEGRATION_E2E_API_KEY_DEFAULT_TTL_SECONDS ||
    typeof value.recorded !== "boolean" ||
    typeof value.present !== "boolean" ||
    typeof value.usable !== "boolean" ||
    (value.present && !value.recorded) ||
    (value.usable && !value.present) ||
    (value.createdAt !== undefined && typeof value.createdAt !== "string") ||
    (value.expiresAt !== undefined && typeof value.expiresAt !== "string") ||
    value.recorded !== hasTimes
  ) {
    throw preflightError("integration E2E credential status returned invalid role metadata");
  }
  return {
    role,
    name,
    keyId: value.keyId,
    scopes: [...scopes],
    ttlSeconds: value.ttlSeconds,
    recorded: value.recorded,
    present: value.present,
    usable: value.usable,
    ...(value.createdAt === undefined ? {} : { createdAt: value.createdAt }),
    ...(value.expiresAt === undefined ? {} : { expiresAt: value.expiresAt }),
  };
}

function safeLocalFileStatus(value: unknown, expectedPath: string): Record<string, unknown> {
  if (
    !isRecord(value) ||
    !exactKeys(value, ["exists", "mode", "path", "symlink"]) ||
    value.path !== expectedPath ||
    typeof value.exists !== "boolean" ||
    (value.mode !== null && !Number.isSafeInteger(value.mode)) ||
    typeof value.symlink !== "boolean"
  ) {
    throw preflightError("integration E2E credential status returned invalid local custody");
  }
  if (
    (value.exists && (value.mode !== 0o600 || value.symlink)) ||
    (!value.exists && (value.mode !== null || value.symlink))
  ) {
    throw preflightError("integration E2E credential status returned unsafe local custody");
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

function exactKeys(value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean {
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}
