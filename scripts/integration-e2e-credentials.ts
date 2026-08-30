import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  credentialAuthorityClaims,
  credentialAuthorityPath,
  credentialAuthorityRequestBody,
  deterministicIntegrationE2eApiKeyIds,
  INTEGRATION_E2E_API_KEY_DEFAULT_TTL_SECONDS,
  INTEGRATION_E2E_API_KEY_PROOF_MAX_TTL_SECONDS,
  INTEGRATION_E2E_CREDENTIAL_ROLE_POLICY,
  INTEGRATION_E2E_EVIDENCE_KEY_NAME,
  INTEGRATION_E2E_EVIDENCE_SCOPES,
  INTEGRATION_E2E_WRITER_KEY_NAME,
  INTEGRATION_E2E_WRITER_SCOPES,
  type IntegrationE2eCredentialAuthorityAction,
  type IntegrationE2eCredentialAuthorityConfig,
  type IntegrationE2eCredentialAuthorityIdentity,
  type IntegrationE2eCredentialPairStatus,
  type IntegrationE2eCredentialRole,
  resolveIntegrationE2eCredentialAuthorityConfig,
} from "../src/integration-e2e-credential-authority.ts";
import { signOperatorAssertion } from "../src/operator-key.ts";
import { parseStrictJson } from "../src/strict-json.ts";
import type { DeployTarget } from "./deploy/target.ts";
import { loadTarget } from "./deploy/target.ts";

/**
 * Offline client for the integration-only, exact-organization API-key route.
 *
 * It never signs in, creates an organization, or calls the ordinary owner API.
 * One operation issues a resources:write writer and a separate resources:read
 * evidence key. The evidence secret remains in external-evaluator custody and
 * is never passed to a Provider or runner. Every network operation carries a
 * fresh proof bound to the currently active authority Worker Version.
 */

export const WRITER_KEY_NAME = INTEGRATION_E2E_WRITER_KEY_NAME;
export const EVIDENCE_KEY_NAME = INTEGRATION_E2E_EVIDENCE_KEY_NAME;
export const KEY_TTL_SECONDS = INTEGRATION_E2E_API_KEY_DEFAULT_TTL_SECONDS;
export const PROOF_TTL_SECONDS = INTEGRATION_E2E_API_KEY_PROOF_MAX_TTL_SECONDS;

export const TARGET_ENVIRONMENT_VARIABLE = "TAKOSERVER_DEPLOY_TARGET_INTEGRATION";
export const PRIVATE_JWK_ENVIRONMENT_VARIABLE =
  "TAKOSERVER_INTEGRATION_E2E_API_KEY_PRIVATE_JWK_PATH";
export const OUTPUT_DIRECTORY_ENVIRONMENT_VARIABLE = "TAKOSERVER_INTEGRATION_E2E_OUTPUT_DIRECTORY";
export const AUTHORITY_CONFIG_ENVIRONMENT_VARIABLE = "TAKOSERVER_INTEGRATION_E2E_AUTHORITY_CONFIG";

const PRIVATE_FILE_MODE = 0o600;
const PRIVATE_DIRECTORY_MODE = 0o700;
const MAX_LOCAL_FILE_BYTES = 64 * 1_024;
const MAX_RESPONSE_BYTES = 64 * 1_024;
const PRIVATE_JWK_KEYS = ["crv", "d", "ext", "key_ops", "kty", "x"] as const;

export interface CredentialAuthorityRouting extends IntegrationE2eCredentialAuthorityIdentity {
  readonly publicJwk: string | { readonly kty: "OKP"; readonly crv: "Ed25519"; readonly x: string };
}

export interface CredentialPaths {
  readonly writerSecret: string;
  readonly evidenceSecret: string;
  readonly metadata: string;
}

export interface CredentialKeyMetadata {
  readonly role: IntegrationE2eCredentialRole;
  readonly name: typeof WRITER_KEY_NAME | typeof EVIDENCE_KEY_NAME;
  readonly keyId: string;
  readonly scopes: readonly string[];
  readonly secretPath: string;
}

export interface CredentialMetadataDocument {
  readonly version: 3;
  readonly kind: "takoserver.integration-e2e-credential-pair@v3";
  readonly origin: string;
  readonly environment: "integration";
  readonly organizationId: string;
  readonly operationId: string;
  readonly ttlSeconds: typeof KEY_TTL_SECONDS;
  readonly requestedAuthority: {
    readonly sourceCommit: string;
    readonly artifactDigest: `sha256:${string}`;
    readonly publicWorkerVersionId: string;
  };
  readonly roles: {
    readonly writer: CredentialKeyMetadata;
    readonly evidence: CredentialKeyMetadata;
  };
}

export interface CredentialStatus {
  readonly kind: "takoserver.integration-e2e-credential-pair-local-status@v3";
  readonly origin: string;
  readonly organizationId: string;
  readonly operationId: string;
  readonly remote: IntegrationE2eCredentialPairStatus | null;
  readonly files: {
    readonly writerSecret: LocalFileStatus;
    readonly evidenceSecret: LocalFileStatus;
    readonly metadata: LocalFileStatus;
  };
}

interface LocalFileStatus {
  readonly path: string;
  readonly exists: boolean;
  readonly mode: number | null;
  readonly symlink: boolean;
}

export type CredentialFetcher = (input: string, init?: RequestInit) => Promise<Response>;

export interface CredentialClientOptions {
  readonly origin: string;
  readonly target: Pick<
    DeployTarget,
    "environment" | "publicOrigin" | "operatorIdentity" | "formAuthority"
  >;
  /** Exact live identity supplied by the owning deploy/status route. */
  readonly authority: CredentialAuthorityRouting;
  readonly privateJwkPath: string;
  readonly outputDirectory: string;
  readonly fetcher?: CredentialFetcher;
  readonly now?: () => Date;
  readonly proofLifetimeSeconds?: number;
  readonly keyLifetimeSeconds?: number;
  /** Test/recovery seam. Production generates a fresh operation id once. */
  readonly operationId?: () => string;
  /** Test-only seam. Production uses the atomic no-replace writer below. */
  readonly writeSecret?: (path: string, secret: string) => Promise<void>;
  /** Test-only seam. Production unlinks only a validated owned file. */
  readonly removeFile?: (path: string) => Promise<void>;
}

interface PreparedOptions {
  readonly origin: string;
  readonly authority: IntegrationE2eCredentialAuthorityConfig & {
    readonly publicJwk: { readonly kty: "OKP"; readonly crv: "Ed25519"; readonly x: string };
  };
  readonly privateJwkPath: string;
  readonly outputDirectory: string;
  readonly fetcher: CredentialFetcher;
  readonly now: () => Date;
  readonly proofLifetimeSeconds: number;
  readonly keyLifetimeSeconds: number;
  readonly operationId: () => string;
  readonly writeSecret: (path: string, secret: string) => Promise<void>;
  readonly removeFile: (path: string) => Promise<void>;
}

interface IssuedCredentialPair {
  readonly pair: IntegrationE2eCredentialPairStatus;
  readonly secrets: { readonly writer: string; readonly evidence: string };
}

export class IntegrationCredentialError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(redactSecrets(message), options);
    this.name = "IntegrationCredentialError";
  }
}

/** Issue exactly once; every indeterminate acknowledgement is reconciled by status, never retried. */
export async function issueIntegrationCredentials(
  options: CredentialClientOptions,
): Promise<CredentialMetadataDocument> {
  const prepared = prepareOptions(options);
  const paths = credentialPaths(prepared.outputDirectory);
  assertDestinationsVacant(paths);
  const privateJwk = await readAndValidatePrivateJwk(
    prepared.privateJwkPath,
    prepared.authority.publicJwk,
  );
  const operationId = prepared.operationId();
  const expectedKeyIds = await deterministicIntegrationE2eApiKeyIds(operationId).catch(() => {
    throw new IntegrationCredentialError("generated credential operation id is invalid");
  });
  const body = credentialAuthorityRequestBody({
    operationId,
    organizationId: prepared.authority.organizationId,
    ttlSeconds: prepared.keyLifetimeSeconds,
  });
  const metadata: CredentialMetadataDocument = {
    version: 3,
    kind: "takoserver.integration-e2e-credential-pair@v3",
    origin: prepared.origin,
    environment: "integration",
    organizationId: prepared.authority.organizationId,
    operationId,
    ttlSeconds: KEY_TTL_SECONDS,
    requestedAuthority: {
      sourceCommit: prepared.authority.sourceCommit,
      artifactDigest: prepared.authority.artifactDigest,
      publicWorkerVersionId: prepared.authority.publicWorkerVersionId,
    },
    roles: {
      writer: {
        role: "writer",
        name: WRITER_KEY_NAME,
        keyId: expectedKeyIds.writer,
        scopes: INTEGRATION_E2E_WRITER_SCOPES,
        secretPath: paths.writerSecret,
      },
      evidence: {
        role: "evidence",
        name: EVIDENCE_KEY_NAME,
        keyId: expectedKeyIds.evidence,
        scopes: INTEGRATION_E2E_EVIDENCE_SCOPES,
        secretPath: paths.evidenceSecret,
      },
    },
  };

  // Local recovery coordinates are durable before the first remote mutation.
  // A hard death can therefore be settled by current-authority status/revoke
  // without guessing an operation id or issuing a second pair.
  await atomicWriteMetadata(paths.metadata, metadata);
  assertPublishedMetadata(paths.metadata, metadata);

  let issued: IssuedCredentialPair;
  try {
    const response = await authorityRequest(prepared, privateJwk, "issue", body);
    issued = parseIssued(response, metadata);
  } catch (error) {
    const reconciled = await reconcileLostIssue(prepared, privateJwk, body, metadata);
    if (reconciled === "no-operation") {
      if (!(await removeCredentialFiles(paths, prepared.removeFile))) {
        throw new IntegrationCredentialError(
          "signed status proved no remote operation but local file cleanup failed",
          { cause: safeError(error) },
        );
      }
      throw safeError(error);
    }
    if (reconciled === "revoked") {
      if (!(await removeCredentialFiles(paths, prepared.removeFile))) {
        throw new IntegrationCredentialError(
          "credential compensation proved remote absence but local file cleanup failed",
          { cause: safeError(error) },
        );
      }
      throw new IntegrationCredentialError(
        "credential-pair secret acknowledgement was lost; both exact roles were revoked and a new operation is required",
        { cause: safeError(error) },
      );
    }
    throw new IntegrationCredentialError(
      "credential compensation is indeterminate; do not retry issue until signed status is available",
      { cause: safeError(error) },
    );
  }

  try {
    await prepared.writeSecret(paths.writerSecret, issued.secrets.writer);
    assertPublishedSecret(paths.writerSecret, issued.secrets.writer);
    await prepared.writeSecret(paths.evidenceSecret, issued.secrets.evidence);
    assertPublishedSecret(paths.evidenceSecret, issued.secrets.evidence);
    return metadata;
  } catch (error) {
    const absent = await revokeAndProveAbsence(prepared, privateJwk, body, metadata);
    if (!absent) {
      throw new IntegrationCredentialError(
        "credential compensation is indeterminate; inspect the exact key and local files before continuing",
        { cause: safeError(error) },
      );
    }
    const filesRemoved = await removeCredentialFiles(paths, prepared.removeFile);
    if (!filesRemoved) {
      throw new IntegrationCredentialError(
        "credential compensation proved remote absence but local file cleanup failed",
        { cause: safeError(error) },
      );
    }
    throw safeError(error);
  }
}

/** Signed remote status when metadata names an exact operation; otherwise local absence only. */
export async function statusIntegrationCredentials(
  options: CredentialClientOptions,
): Promise<CredentialStatus> {
  const prepared = prepareOptions(options);
  const paths = credentialPaths(prepared.outputDirectory);
  const metadata = readMetadataIfPresent(paths.metadata);
  if (!metadata) {
    return {
      kind: "takoserver.integration-e2e-credential-pair-local-status@v3",
      origin: prepared.origin,
      organizationId: prepared.authority.organizationId,
      operationId: "",
      remote: null,
      files: fileStatuses(paths),
    };
  }
  await assertMetadataMatches(metadata, prepared, paths);
  const privateJwk = await readAndValidatePrivateJwk(
    prepared.privateJwkPath,
    prepared.authority.publicJwk,
  );
  const body = requestBodyFromMetadata(metadata);
  const response = await authorityRequest(prepared, privateJwk, "status", body);
  const remote = parseStatus(response, metadata);
  return {
    kind: "takoserver.integration-e2e-credential-pair-local-status@v3",
    origin: prepared.origin,
    organizationId: prepared.authority.organizationId,
    operationId: metadata.operationId,
    remote,
    files: fileStatuses(paths),
  };
}

/** Revoke, resume only a signed revoking fence, then prove absence before local cleanup. */
export async function revokeIntegrationCredentials(options: CredentialClientOptions): Promise<{
  readonly organizationId: string;
  readonly operationId: string;
  readonly keyIds: { readonly writer: string; readonly evidence: string };
  readonly absent: true;
}> {
  const prepared = prepareOptions(options);
  const paths = credentialPaths(prepared.outputDirectory);
  const metadata = readMetadata(paths.metadata);
  await assertMetadataMatches(metadata, prepared, paths);
  const privateJwk = await readAndValidatePrivateJwk(
    prepared.privateJwkPath,
    prepared.authority.publicJwk,
  );
  const body = requestBodyFromMetadata(metadata);

  const status = await revokeThenSignedStatus(prepared, privateJwk, body, metadata);
  if (
    !status.terminal ||
    status.state !== "revoked" ||
    status.completeness !== "absent" ||
    status.roles.writer.present ||
    status.roles.evidence.present ||
    status.legacyKeyPresent
  ) {
    throw new IntegrationCredentialError(
      "credential-pair revoke is incomplete because signed status is not a terminal two-role tombstone",
    );
  }
  if (!(await removeCredentialFiles(paths, prepared.removeFile))) {
    throw new IntegrationCredentialError(
      "credential revoke succeeded but local file cleanup failed",
    );
  }
  return {
    organizationId: metadata.organizationId,
    operationId: metadata.operationId,
    keyIds: {
      writer: metadata.roles.writer.keyId,
      evidence: metadata.roles.evidence.keyId,
    },
    absent: true,
  };
}

export function credentialPaths(outputDirectory: string): CredentialPaths {
  return {
    writerSecret: join(outputDirectory, "task-0037-integration-writer.secret"),
    evidenceSecret: join(outputDirectory, "task-0037-integration-evidence.secret"),
    metadata: join(outputDirectory, "task-0037-integration-credential-pair.json"),
  };
}

function prepareOptions(options: CredentialClientOptions): PreparedOptions {
  if (options.target.environment !== "integration") {
    throw new IntegrationCredentialError(
      "integration credential helper requires an integration target",
    );
  }
  const origin = httpsOrigin(options.origin);
  if (options.target.publicOrigin !== origin) {
    throw new IntegrationCredentialError("integration origin does not match deploy target");
  }
  const authority = resolveIntegrationE2eCredentialAuthorityConfig(
    options.authority as IntegrationE2eCredentialAuthorityConfig,
  );
  if (!authority) throw new IntegrationCredentialError("credential authority is unavailable");
  for (const other of [
    options.target.operatorIdentity?.publicJwk,
    options.target.formAuthority?.operatorPublicJwk,
  ]) {
    if (other?.x === authority.publicJwk.x) {
      throw new IntegrationCredentialError(
        "integration API-key authority must use a dedicated Ed25519 key",
      );
    }
  }
  const keyLifetimeSeconds = options.keyLifetimeSeconds ?? KEY_TTL_SECONDS;
  if (keyLifetimeSeconds !== KEY_TTL_SECONDS) {
    throw new IntegrationCredentialError("credential-pair lifetime must be exactly 3600 seconds");
  }
  const proofLifetimeSeconds = options.proofLifetimeSeconds ?? PROOF_TTL_SECONDS;
  if (
    !Number.isSafeInteger(proofLifetimeSeconds) ||
    proofLifetimeSeconds <= 0 ||
    proofLifetimeSeconds > INTEGRATION_E2E_API_KEY_PROOF_MAX_TTL_SECONDS
  ) {
    throw new IntegrationCredentialError("authority proof lifetime is outside its bounded range");
  }
  const privateJwkPath = validatePrivatePath(options.privateJwkPath);
  const outputDirectory = validateOutputDirectory(options.outputDirectory);
  const now = options.now ?? (() => new Date());
  return {
    origin,
    authority,
    privateJwkPath,
    outputDirectory,
    fetcher: options.fetcher ?? fetch,
    now,
    proofLifetimeSeconds,
    keyLifetimeSeconds,
    operationId:
      options.operationId ??
      (() => `issue-${now().getTime().toString(36)}-${crypto.randomUUID().replaceAll("-", "")}`),
    writeSecret: options.writeSecret ?? atomicWriteSecret,
    removeFile: options.removeFile ?? removeFile,
  };
}

async function reconcileLostIssue(
  prepared: PreparedOptions,
  privateJwk: Readonly<Record<string, unknown>>,
  body: ReturnType<typeof credentialAuthorityRequestBody>,
  metadata: CredentialMetadataDocument,
): Promise<"no-operation" | "revoked" | "indeterminate"> {
  let status: IntegrationE2eCredentialPairStatus;
  try {
    status = parseStatus(await authorityRequest(prepared, privateJwk, "status", body), metadata);
  } catch {
    return "indeterminate";
  }
  if (
    status.state === "unregistered" &&
    status.completeness === "absent" &&
    !status.legacyKeyPresent
  ) {
    return "no-operation";
  }
  return (await revokeAndProveAbsence(prepared, privateJwk, body, metadata))
    ? "revoked"
    : "indeterminate";
}

async function revokeAndProveAbsence(
  prepared: PreparedOptions,
  privateJwk: Readonly<Record<string, unknown>>,
  body: ReturnType<typeof credentialAuthorityRequestBody>,
  metadata: CredentialMetadataDocument,
): Promise<boolean> {
  try {
    const status = await revokeThenSignedStatus(prepared, privateJwk, body, metadata);
    return (
      status.state === "revoked" &&
      status.terminal &&
      status.completeness === "absent" &&
      !status.roles.writer.present &&
      !status.roles.evidence.present &&
      !status.legacyKeyPresent
    );
  } catch {
    return false;
  }
}

async function revokeThenSignedStatus(
  prepared: PreparedOptions,
  privateJwk: Readonly<Record<string, unknown>>,
  body: ReturnType<typeof credentialAuthorityRequestBody>,
  metadata: CredentialMetadataDocument,
): Promise<IntegrationE2eCredentialPairStatus> {
  await authorityRequest(prepared, privateJwk, "revoke", body).catch(() => null);
  let status = parseStatus(await authorityRequest(prepared, privateJwk, "status", body), metadata);
  if (status.state === "revoking") {
    // Signed status proves the exact operation already owns the monotonic
    // revoke fence. Resuming that idempotent settlement is safe; issuing a
    // second secret-bearing operation is never inferred from this recovery.
    await authorityRequest(prepared, privateJwk, "revoke", body).catch(() => null);
    status = parseStatus(await authorityRequest(prepared, privateJwk, "status", body), metadata);
  }
  return status;
}

async function authorityRequest(
  prepared: PreparedOptions,
  privateJwk: Readonly<Record<string, unknown>>,
  action: IntegrationE2eCredentialAuthorityAction,
  body: ReturnType<typeof credentialAuthorityRequestBody>,
): Promise<{ readonly status: number; readonly body: unknown }> {
  const path = credentialAuthorityPath(action);
  const claims = await credentialAuthorityClaims({ action, body, identity: prepared.authority });
  const assertion = await signOperatorAssertion({
    privateJwk: JSON.stringify(privateJwk),
    claims,
    nowSeconds: Math.floor(prepared.now().getTime() / 1_000),
    lifetimeSeconds: prepared.proofLifetimeSeconds,
  });
  let response: Response;
  try {
    response = await prepared.fetcher(new URL(path, `${prepared.origin}/`).toString(), {
      method: "POST",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${assertion}`,
        "cache-control": "no-store",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      redirect: "error",
    });
  } catch {
    throw new IntegrationCredentialError(`HTTP POST ${path} failed without an acknowledgement`);
  }
  const bytes = await boundedResponse(response);
  let parsed: unknown;
  try {
    parsed = parseStrictJson(bytes, MAX_RESPONSE_BYTES);
  } catch {
    throw new IntegrationCredentialError(`HTTP POST ${path} returned malformed JSON`);
  }
  return { status: response.status, body: parsed };
}

function parseIssued(
  response: { readonly status: number; readonly body: unknown },
  metadata: CredentialMetadataDocument,
): IssuedCredentialPair {
  if (response.status !== 201) {
    throw new IntegrationCredentialError(
      `credential-pair issue returned status ${response.status}${safeResponseCode(response.body)}`,
    );
  }
  const value = responseRecord(response.body);
  if (!exactKeys(value, ["kind", "pair", "secrets"])) {
    throw new IntegrationCredentialError("credential-pair issue response is malformed");
  }
  const pair = parseStatusValue(value.pair, metadata);
  const secrets = responseRecord(value.secrets);
  if (
    value.kind !== "takoserver.integration-e2e-credential-pair-issued@v1" ||
    !exactKeys(secrets, ["evidence", "writer"]) ||
    pair.state !== "active" ||
    pair.completeness !== "complete" ||
    pair.terminal ||
    pair.legacyKeyPresent ||
    pair.provenance === null ||
    !pair.roles.writer.present ||
    !pair.roles.writer.usable ||
    !pair.roles.evidence.present ||
    !pair.roles.evidence.usable ||
    typeof secrets.writer !== "string" ||
    typeof secrets.evidence !== "string" ||
    !validIssuedSecret(secrets.writer) ||
    !validIssuedSecret(secrets.evidence) ||
    secrets.writer === secrets.evidence
  ) {
    throw new IntegrationCredentialError("credential-pair issue response does not match request");
  }
  return { pair, secrets: { writer: secrets.writer, evidence: secrets.evidence } };
}

function parseStatus(
  response: { readonly status: number; readonly body: unknown },
  metadata: CredentialMetadataDocument,
): IntegrationE2eCredentialPairStatus {
  if (response.status !== 200) {
    throw new IntegrationCredentialError(
      `credential-pair status returned status ${response.status}${safeResponseCode(response.body)}`,
    );
  }
  return parseStatusValue(response.body, metadata);
}

function parseStatusValue(
  input: unknown,
  metadata: CredentialMetadataDocument,
): IntegrationE2eCredentialPairStatus {
  const value = responseRecord(input);
  if (
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
    value.operationId !== metadata.operationId ||
    value.organizationId !== metadata.organizationId ||
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
    typeof value.legacyKeyPresent !== "boolean"
  ) {
    throw new IntegrationCredentialError("credential-pair status response is malformed");
  }
  const roles = responseRecord(value.roles);
  if (!exactKeys(roles, ["evidence", "writer"])) {
    throw new IntegrationCredentialError("credential-pair role status is malformed");
  }
  const writer = parseRoleStatus(roles.writer, metadata.roles.writer, metadata.ttlSeconds);
  const evidence = parseRoleStatus(roles.evidence, metadata.roles.evidence, metadata.ttlSeconds);
  let provenance: IntegrationE2eCredentialPairStatus["provenance"] = null;
  if (value.provenance !== null) {
    const candidate = responseRecord(value.provenance);
    if (
      !exactKeys(candidate, ["artifactDigest", "publicWorkerVersionId", "sourceCommit"]) ||
      candidate.sourceCommit !== metadata.requestedAuthority.sourceCommit ||
      candidate.artifactDigest !== metadata.requestedAuthority.artifactDigest ||
      candidate.publicWorkerVersionId !== metadata.requestedAuthority.publicWorkerVersionId
    ) {
      throw new IntegrationCredentialError("credential-pair provenance does not match metadata");
    }
    provenance = {
      sourceCommit: candidate.sourceCommit as string,
      artifactDigest: candidate.artifactDigest as `sha256:${string}`,
      publicWorkerVersionId: candidate.publicWorkerVersionId as string,
    };
  }
  const state = value.state as IntegrationE2eCredentialPairStatus["state"];
  const completeness = value.completeness as IntegrationE2eCredentialPairStatus["completeness"];
  const durable = ["prepared", "issuing", "active", "partial", "revoking", "revoked"].includes(
    state,
  );
  const terminal =
    state === "revoked" &&
    completeness === "absent" &&
    !value.legacyKeyPresent &&
    !writer.present &&
    !evidence.present;
  if (
    completeness !== pairCompleteness(writer.present, evidence.present) ||
    value.terminal !== terminal ||
    (durable && (value.fence === null || provenance === null)) ||
    (!durable && (value.fence !== null || provenance !== null)) ||
    (state === "unregistered" && (writer.recorded || evidence.recorded || value.legacyKeyPresent))
  ) {
    throw new IntegrationCredentialError("credential-pair status invariants are malformed");
  }
  return {
    kind: "takoserver.integration-e2e-credential-pair-status@v1",
    operationId: metadata.operationId,
    organizationId: metadata.organizationId,
    state,
    fence: value.fence as number | null,
    completeness,
    terminal: value.terminal,
    legacyKeyPresent: value.legacyKeyPresent,
    provenance,
    roles: { writer, evidence },
  };
}

function parseRoleStatus(
  input: unknown,
  expected: CredentialKeyMetadata,
  ttlSeconds: number,
): IntegrationE2eCredentialPairStatus["roles"]["writer"] {
  const value = responseRecord(input);
  const hasTimes = "createdAt" in value || "expiresAt" in value;
  const expectedKeys = [
    "keyId",
    "name",
    "present",
    "recorded",
    "role",
    "scopes",
    "ttlSeconds",
    "usable",
    ...(hasTimes ? ["createdAt", "expiresAt"] : []),
  ];
  if (
    !exactKeys(value, expectedKeys) ||
    value.role !== expected.role ||
    value.name !== expected.name ||
    value.keyId !== expected.keyId ||
    JSON.stringify(value.scopes) !== JSON.stringify(expected.scopes) ||
    value.ttlSeconds !== ttlSeconds ||
    typeof value.recorded !== "boolean" ||
    typeof value.present !== "boolean" ||
    typeof value.usable !== "boolean" ||
    (value.present && !value.recorded) ||
    (value.usable && !value.present) ||
    value.recorded !== hasTimes
  ) {
    throw new IntegrationCredentialError("credential-pair role status is malformed");
  }
  if (
    hasTimes &&
    (typeof value.createdAt !== "string" ||
      !isCanonicalInstant(value.createdAt) ||
      typeof value.expiresAt !== "string" ||
      !isCanonicalInstant(value.expiresAt) ||
      Date.parse(value.expiresAt) - Date.parse(value.createdAt) !== ttlSeconds * 1_000)
  ) {
    throw new IntegrationCredentialError("credential-pair role expiry is malformed");
  }
  return {
    role: expected.role,
    name: expected.name,
    keyId: expected.keyId,
    scopes: expected.scopes as readonly ("resources:write" | "resources:read")[],
    ttlSeconds,
    recorded: value.recorded,
    present: value.present,
    usable: value.usable,
    ...(typeof value.createdAt === "string" ? { createdAt: value.createdAt } : {}),
    ...(typeof value.expiresAt === "string" ? { expiresAt: value.expiresAt } : {}),
  };
}

function pairCompleteness(writer: boolean, evidence: boolean): "absent" | "partial" | "complete" {
  return writer && evidence ? "complete" : writer || evidence ? "partial" : "absent";
}

function validIssuedSecret(value: string): boolean {
  return value.length >= 16 && value.length <= 512;
}

function safeResponseCode(value: unknown): string {
  if (!isRecord(value) || !isRecord(value.error)) return "";
  const code = value.error.code;
  return typeof code === "string" && /^[a-z][a-z0-9_]{0,63}$/u.test(code) ? ` (${code})` : "";
}

async function boundedResponse(response: Response): Promise<Uint8Array> {
  const declared = response.headers.get("content-length");
  if (declared && (!/^\d+$/u.test(declared) || Number(declared) > MAX_RESPONSE_BYTES)) {
    throw new IntegrationCredentialError("credential authority returned an oversized response");
  }
  if (!response.body) throw new IntegrationCredentialError("credential authority returned no body");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new IntegrationCredentialError("credential authority returned an oversized response");
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

async function readAndValidatePrivateJwk(
  path: string,
  publicJwk: { readonly kty: "OKP"; readonly crv: "Ed25519"; readonly x: string },
): Promise<Readonly<Record<string, unknown>>> {
  const raw = readOwnedRegular(path, "integration E2E private JWK");
  let value: unknown;
  try {
    value = parseStrictJson(new TextEncoder().encode(raw), MAX_LOCAL_FILE_BYTES);
  } catch {
    throw new IntegrationCredentialError("integration E2E private JWK is not valid JSON");
  }
  if (
    !isRecord(value) ||
    !exactKeys(value, PRIVATE_JWK_KEYS) ||
    value.kty !== "OKP" ||
    value.crv !== "Ed25519" ||
    value.ext !== true ||
    JSON.stringify(value.key_ops) !== JSON.stringify(["sign"]) ||
    typeof value.x !== "string" ||
    typeof value.d !== "string" ||
    value.x !== publicJwk.x
  ) {
    throw new IntegrationCredentialError(
      "integration E2E private JWK must match the dedicated target public JWK",
    );
  }
  try {
    const privateKey = await crypto.subtle.importKey("jwk", value, "Ed25519", false, ["sign"]);
    const publicKey = await crypto.subtle.importKey(
      "jwk",
      { ...publicJwk, ext: true, key_ops: ["verify"] },
      "Ed25519",
      false,
      ["verify"],
    );
    const message = new TextEncoder().encode("takoserver.integration-e2e-api-key@v1");
    const signature = await crypto.subtle.sign("Ed25519", privateKey, message);
    if (!(await crypto.subtle.verify("Ed25519", publicKey, signature, message))) throw new Error();
  } catch {
    throw new IntegrationCredentialError(
      "integration E2E private JWK cannot prove the dedicated target public JWK",
    );
  }
  return value;
}

function assertDestinationsVacant(paths: CredentialPaths): void {
  for (const path of [paths.writerSecret, paths.evidenceSecret, paths.metadata]) {
    try {
      lstatSync(path);
      throw new IntegrationCredentialError("credential destination already exists");
    } catch (error) {
      if (error instanceof IntegrationCredentialError) throw error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new IntegrationCredentialError("credential destination cannot be inspected");
      }
    }
  }
}

async function atomicWriteSecret(path: string, secret: string): Promise<void> {
  await atomicWrite(path, `${secret}\n`, "credential secret");
}

async function atomicWriteMetadata(
  path: string,
  metadata: CredentialMetadataDocument,
): Promise<void> {
  await atomicWrite(path, `${JSON.stringify(metadata, null, 2)}\n`, "credential metadata");
}

async function atomicWrite(path: string, contents: string, label: string): Promise<void> {
  assertOwnedDestination(path, label);
  const directory = dirname(path);
  const temp = join(directory, `.${basename(path)}.${crypto.randomUUID()}.tmp`);
  let fd: number | null = null;
  try {
    fd = openSync(temp, "wx", PRIVATE_FILE_MODE);
    writeFileSync(fd, contents, { encoding: "utf8" });
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    publishNoReplace(temp, path, label);
    assertOwnedRegular(path, label);
    const directoryFd = openSync(directory, "r");
    try {
      fsyncSync(directoryFd);
    } finally {
      closeSync(directoryFd);
    }
  } catch (error) {
    if (fd !== null) closeSync(fd);
    try {
      unlinkSync(temp);
    } catch {
      // The temporary path may already have been linked and removed.
    }
    throw safeError(error);
  }
}

function publishNoReplace(temp: string, path: string, label: string): void {
  let linked = false;
  try {
    linkSync(temp, path);
    linked = true;
    unlinkSync(temp);
  } catch (error) {
    if (linked) {
      try {
        unlinkSync(path);
      } catch {
        // Keep the safe publication failure.
      }
    }
    try {
      unlinkSync(temp);
    } catch {
      // Nothing to remove.
    }
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new IntegrationCredentialError(`${label} destination already exists`);
    }
    throw new IntegrationCredentialError(`${label} publication failed`);
  }
}

function assertPublishedSecret(path: string, secret: string): void {
  if (readOwnedRegular(path, "credential secret") !== `${secret}\n`) {
    throw new IntegrationCredentialError("credential secret publication was replaced");
  }
}

function assertPublishedMetadata(path: string, expected: CredentialMetadataDocument): void {
  const actual = readMetadata(path);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new IntegrationCredentialError("credential metadata publication was replaced");
  }
}

async function removeCredentialFiles(
  paths: CredentialPaths,
  remove: (path: string) => Promise<void>,
): Promise<boolean> {
  const entries = [paths.writerSecret, paths.evidenceSecret, paths.metadata] as const;
  try {
    const expected = credentialPaths(validateOutputDirectory(dirname(paths.metadata)));
    if (
      expected.writerSecret !== paths.writerSecret ||
      expected.evidenceSecret !== paths.evidenceSecret ||
      expected.metadata !== paths.metadata
    ) {
      return false;
    }
  } catch {
    return false;
  }
  let complete = true;
  for (const path of entries) {
    try {
      validateOutputDirectory(dirname(path));
      if (!pathEntryExists(path)) continue;
      // Remote terminal absence has already been proved. Unlink the exact leaf
      // entry without following it so a dangling symlink cannot survive merely
      // because existsSync would have treated its missing target as absent.
      await remove(path);
      if (pathEntryExists(path)) complete = false;
    } catch {
      complete = false;
    }
  }
  for (const path of entries) {
    try {
      validateOutputDirectory(dirname(path));
      if (pathEntryExists(path)) complete = false;
    } catch {
      complete = false;
    }
  }
  return complete;
}

function removeFile(path: string): Promise<void> {
  unlinkSync(path);
  return Promise.resolve();
}

function readMetadata(path: string): CredentialMetadataDocument {
  return parseMetadata(readOwnedRegular(path, "credential metadata"));
}

function readMetadataIfPresent(path: string): CredentialMetadataDocument | null {
  return pathEntryExists(path) ? readMetadata(path) : null;
}

function parseMetadata(raw: string): CredentialMetadataDocument {
  let value: unknown;
  try {
    value = parseStrictJson(new TextEncoder().encode(raw), MAX_LOCAL_FILE_BYTES);
  } catch {
    throw new IntegrationCredentialError("credential metadata is not valid strict JSON");
  }
  const root = responseRecord(value);
  if (
    !exactKeys(root, [
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
    root.version !== 3 ||
    root.kind !== "takoserver.integration-e2e-credential-pair@v3" ||
    root.environment !== "integration" ||
    typeof root.origin !== "string" ||
    typeof root.organizationId !== "string" ||
    typeof root.operationId !== "string" ||
    root.ttlSeconds !== KEY_TTL_SECONDS
  ) {
    throw new IntegrationCredentialError("credential metadata is malformed");
  }
  const requestedAuthority = responseRecord(root.requestedAuthority);
  if (
    !exactKeys(requestedAuthority, ["artifactDigest", "publicWorkerVersionId", "sourceCommit"]) ||
    typeof requestedAuthority.sourceCommit !== "string" ||
    !/^[0-9a-f]{40}$/u.test(requestedAuthority.sourceCommit) ||
    typeof requestedAuthority.artifactDigest !== "string" ||
    !/^sha256:[0-9a-f]{64}$/u.test(requestedAuthority.artifactDigest) ||
    typeof requestedAuthority.publicWorkerVersionId !== "string" ||
    !/^[0-9a-f-]{36}$/u.test(requestedAuthority.publicWorkerVersionId)
  ) {
    throw new IntegrationCredentialError("credential metadata authority is malformed");
  }
  const roles = responseRecord(root.roles);
  if (!exactKeys(roles, ["evidence", "writer"])) {
    throw new IntegrationCredentialError("credential metadata roles are malformed");
  }
  const writer = parseMetadataRole(roles.writer, "writer");
  const evidence = parseMetadataRole(roles.evidence, "evidence");
  return {
    version: 3,
    kind: "takoserver.integration-e2e-credential-pair@v3",
    origin: root.origin,
    environment: "integration",
    organizationId: root.organizationId,
    operationId: root.operationId,
    ttlSeconds: KEY_TTL_SECONDS,
    requestedAuthority: {
      sourceCommit: requestedAuthority.sourceCommit,
      artifactDigest: requestedAuthority.artifactDigest as `sha256:${string}`,
      publicWorkerVersionId: requestedAuthority.publicWorkerVersionId,
    },
    roles: { writer, evidence },
  };
}

function parseMetadataRole(
  input: unknown,
  role: IntegrationE2eCredentialRole,
): CredentialKeyMetadata {
  const value = responseRecord(input);
  const expectedName = role === "writer" ? WRITER_KEY_NAME : EVIDENCE_KEY_NAME;
  const expectedScopes =
    role === "writer" ? INTEGRATION_E2E_WRITER_SCOPES : INTEGRATION_E2E_EVIDENCE_SCOPES;
  if (
    !exactKeys(value, ["keyId", "name", "role", "scopes", "secretPath"]) ||
    value.role !== role ||
    value.name !== expectedName ||
    typeof value.keyId !== "string" ||
    JSON.stringify(value.scopes) !== JSON.stringify(expectedScopes) ||
    typeof value.secretPath !== "string"
  ) {
    throw new IntegrationCredentialError("credential metadata role is malformed");
  }
  return {
    role,
    name: expectedName,
    keyId: value.keyId,
    scopes: expectedScopes,
    secretPath: value.secretPath,
  };
}

async function assertMetadataMatches(
  metadata: CredentialMetadataDocument,
  prepared: PreparedOptions,
  paths: CredentialPaths,
): Promise<void> {
  const expectedKeyIds = await deterministicIntegrationE2eApiKeyIds(metadata.operationId).catch(
    () => null,
  );
  if (
    metadata.origin !== prepared.origin ||
    metadata.environment !== "integration" ||
    metadata.organizationId !== prepared.authority.organizationId ||
    metadata.ttlSeconds !== KEY_TTL_SECONDS ||
    expectedKeyIds === null ||
    metadata.roles.writer.keyId !== expectedKeyIds.writer ||
    metadata.roles.evidence.keyId !== expectedKeyIds.evidence ||
    metadata.roles.writer.keyId === metadata.roles.evidence.keyId ||
    metadata.roles.writer.secretPath !== paths.writerSecret ||
    metadata.roles.evidence.secretPath !== paths.evidenceSecret
  ) {
    throw new IntegrationCredentialError("credential metadata does not match exact live routing");
  }
}

function requestBodyFromMetadata(metadata: CredentialMetadataDocument) {
  return credentialAuthorityRequestBody({
    operationId: metadata.operationId,
    organizationId: metadata.organizationId,
    roles: INTEGRATION_E2E_CREDENTIAL_ROLE_POLICY,
    ttlSeconds: metadata.ttlSeconds,
  });
}

function fileStatuses(paths: CredentialPaths): CredentialStatus["files"] {
  return {
    writerSecret: localFileStatus(paths.writerSecret),
    evidenceSecret: localFileStatus(paths.evidenceSecret),
    metadata: localFileStatus(paths.metadata),
  };
}

function localFileStatus(path: string): LocalFileStatus {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) {
      throw new IntegrationCredentialError("credential path entry must not be a symlink");
    }
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      (stat.mode & 0o777) !== PRIVATE_FILE_MODE ||
      (typeof process.getuid === "function" && stat.uid !== process.getuid())
    ) {
      throw new IntegrationCredentialError(
        "credential path entry must be an owned regular file with mode 0600",
      );
    }
    return { path, exists: true, mode: stat.mode & 0o777, symlink: stat.isSymbolicLink() };
  } catch (error) {
    if (error instanceof IntegrationCredentialError) throw error;
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { path, exists: false, mode: null, symlink: false };
    }
    throw new IntegrationCredentialError("credential path entry cannot be inspected");
  }
}

function pathEntryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw new IntegrationCredentialError("credential path entry cannot be inspected");
  }
}

function validatePrivatePath(path: string): string {
  if (!path || path.trim() !== path) {
    throw new IntegrationCredentialError("integration E2E private JWK path is required");
  }
  if (!isAbsolute(path)) {
    throw new IntegrationCredentialError("integration E2E private JWK path must be absolute");
  }
  return validateLinkFreePath(resolve(path), false, "integration E2E private JWK");
}

function validateOutputDirectory(path: string): string {
  if (!isAbsolute(path)) {
    throw new IntegrationCredentialError("credential output directory must be absolute");
  }
  const normalized = validateLinkFreePath(path, true, "credential output directory");
  if (isInsideRepository(normalized)) {
    throw new IntegrationCredentialError(
      "credential output directory must be outside every Git repository",
    );
  }
  const stat = lstatSync(normalized);
  if (
    (stat.mode & 0o777) !== PRIVATE_DIRECTORY_MODE ||
    (typeof process.getuid === "function" && stat.uid !== process.getuid())
  ) {
    throw new IntegrationCredentialError(
      "credential output directory must be owned by this user with mode 0700",
    );
  }
  return normalized;
}

function validateLinkFreePath(path: string, directory: boolean, label: string): string {
  const normalized = resolve(path);
  const parts = normalized.split(sep).filter(Boolean);
  let current: string = sep;
  for (const part of parts) {
    current = join(current, part);
    let stat: ReturnType<typeof lstatSync>;
    try {
      stat = lstatSync(current);
    } catch {
      throw new IntegrationCredentialError(`${label} path does not exist`);
    }
    if (stat.isSymbolicLink())
      throw new IntegrationCredentialError(`${label} path contains a symlink`);
    if (current !== normalized && !stat.isDirectory()) {
      throw new IntegrationCredentialError(`${label} path has a non-directory parent`);
    }
  }
  const stat = lstatSync(normalized);
  if (directory ? !stat.isDirectory() : !stat.isFile()) {
    throw new IntegrationCredentialError(
      `${label} is not a regular ${directory ? "directory" : "file"}`,
    );
  }
  return normalized;
}

function readOwnedRegular(path: string, label: string): string {
  const normalized = validateLinkFreePath(path, false, label);
  let fd: number | null = null;
  try {
    fd = openSync(normalized, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      (stat.mode & 0o777) !== PRIVATE_FILE_MODE ||
      (typeof process.getuid === "function" && stat.uid !== process.getuid())
    ) {
      throw new IntegrationCredentialError(
        `${label} must be an owned link-free regular file with mode 0600`,
      );
    }
    const raw = readFileSync(fd, "utf8");
    if (raw.length > MAX_LOCAL_FILE_BYTES) {
      throw new IntegrationCredentialError(`${label} is too large`);
    }
    return raw;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

function assertOwnedRegular(path: string, label: string): void {
  readOwnedRegular(path, label);
}

function assertOwnedDestination(path: string, label: string): void {
  const directory = validateLinkFreePath(dirname(path), true, `${label} parent`);
  if ((lstatSync(directory).mode & 0o777) !== PRIVATE_DIRECTORY_MODE) {
    throw new IntegrationCredentialError(`${label} parent must have mode 0700`);
  }
  if (isInsideRepository(directory)) {
    throw new IntegrationCredentialError(`${label} must be outside every Git repository`);
  }
  if (join(directory, basename(path)) !== path) {
    throw new IntegrationCredentialError(`${label} path is not canonical`);
  }
}

function isInsideRepository(path: string): boolean {
  let current = path;
  while (true) {
    if (existsSync(join(current, ".git"))) return true;
    const parent = dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

function httpsOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new IntegrationCredentialError("integration origin must be an HTTPS origin");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new IntegrationCredentialError("integration origin must be an HTTPS origin");
  }
  return url.origin;
}

function responseRecord(value: unknown): Readonly<Record<string, unknown>> {
  if (!isRecord(value)) throw new IntegrationCredentialError("credential response is malformed");
  return value;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean {
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}

function isCanonicalInstant(value: string): boolean {
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function redactSecrets(message: string): string {
  return message
    .replace(/Bearer\s+[^\s,}]+/giu, "Bearer [REDACTED]")
    .replace(/(assertion|sessionToken|secret|token|d)\s*[=:]\s*[^,\s}]+/giu, "$1=[REDACTED]");
}

function safeError(error: unknown): IntegrationCredentialError {
  return error instanceof IntegrationCredentialError
    ? error
    : new IntegrationCredentialError("integration credential operation failed");
}

export function loadIntegrationEnvironment(environment: NodeJS.ProcessEnv = process.env): {
  readonly targetPath: string;
  readonly privateJwkPath: string;
  readonly outputDirectory: string;
  readonly authority: CredentialAuthorityRouting;
} {
  const targetPath = requiredEnvironment(environment, TARGET_ENVIRONMENT_VARIABLE);
  const privateJwkPath = requiredEnvironment(environment, PRIVATE_JWK_ENVIRONMENT_VARIABLE);
  const outputDirectory = requiredEnvironment(environment, OUTPUT_DIRECTORY_ENVIRONMENT_VARIABLE);
  const authorityJson = requiredEnvironment(environment, AUTHORITY_CONFIG_ENVIRONMENT_VARIABLE);
  let authority: unknown;
  try {
    authority = parseStrictJson(new TextEncoder().encode(authorityJson), MAX_LOCAL_FILE_BYTES);
  } catch {
    throw new IntegrationCredentialError(
      "integration credential authority config is not valid JSON",
    );
  }
  const resolved = resolveIntegrationE2eCredentialAuthorityConfig(
    authority as IntegrationE2eCredentialAuthorityConfig,
  );
  if (!resolved) throw new IntegrationCredentialError("integration credential authority is absent");
  return { targetPath, privateJwkPath, outputDirectory, authority: resolved };
}

function requiredEnvironment(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name];
  if (!value || value.trim() !== value) throw new IntegrationCredentialError(`${name} is required`);
  return value;
}

async function cli(): Promise<void> {
  const action = process.argv[2];
  if (
    process.argv.length !== 3 ||
    (action !== "issue" && action !== "status" && action !== "revoke")
  ) {
    throw new IntegrationCredentialError(
      "usage: integration-e2e-credentials.ts <issue|status|revoke>",
    );
  }
  const environment = loadIntegrationEnvironment();
  const target = loadTarget(environment.targetPath, "integration");
  const options: CredentialClientOptions = {
    origin: target.publicOrigin,
    target,
    authority: environment.authority,
    privateJwkPath: environment.privateJwkPath,
    outputDirectory: environment.outputDirectory,
  };
  const result =
    action === "issue"
      ? await issueIntegrationCredentials(options)
      : action === "status"
        ? await statusIntegrationCredentials(options)
        : await revokeIntegrationCredentials(options);
  // Every result type is nonsecret. Assertions and the two one-time API-key
  // secrets exist only in request memory and the owner-only secret files.
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await cli().catch((error: unknown) => {
    process.stderr.write(`${safeError(error).message}\n`);
    process.exitCode = 1;
  });
}
