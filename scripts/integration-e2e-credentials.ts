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
  deterministicIntegrationE2eApiKeyId,
  INTEGRATION_E2E_API_KEY_DEFAULT_TTL_SECONDS,
  INTEGRATION_E2E_API_KEY_MAX_TTL_SECONDS,
  INTEGRATION_E2E_API_KEY_NAME,
  INTEGRATION_E2E_API_KEY_PROOF_MAX_TTL_SECONDS,
  INTEGRATION_E2E_API_KEY_SCOPES,
  type IntegrationE2eCredentialAuthorityAction,
  type IntegrationE2eCredentialAuthorityConfig,
  type IntegrationE2eCredentialAuthorityIdentity,
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
 * One operation issues one resources:write key; writer implies reader in the
 * product authorization model. Every network operation carries a fresh proof
 * bound to the exact deployed source, artifact, and active Worker Version.
 */

export const WRITER_KEY_NAME = INTEGRATION_E2E_API_KEY_NAME;
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
  readonly secret: string;
  readonly metadata: string;
}

export interface CredentialKeyMetadata {
  readonly name: typeof WRITER_KEY_NAME;
  readonly keyId: string;
  readonly operationId: string;
  readonly scopes: typeof INTEGRATION_E2E_API_KEY_SCOPES;
  readonly ttlSeconds: number;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly secretPath: string;
}

export interface CredentialMetadataDocument {
  readonly version: 2;
  readonly kind: "takoserver.integration-e2e-credential@v2";
  readonly origin: string;
  readonly environment: "integration";
  readonly organizationId: string;
  readonly sourceCommit: string;
  readonly artifactDigest: `sha256:${string}`;
  readonly publicWorkerVersionId: string;
  readonly key: CredentialKeyMetadata;
}

export interface CredentialRemoteStatus {
  readonly keyId: string;
  readonly operationId: string;
  readonly present: boolean;
  readonly usable: boolean;
  readonly organizationId?: string;
  readonly scopes?: readonly string[];
  readonly createdAt?: string;
  readonly expiresAt?: string;
}

export interface CredentialStatus {
  readonly kind: "takoserver.integration-e2e-credential-status@v2";
  readonly origin: string;
  readonly organizationId: string;
  readonly keyId: string;
  readonly remote: CredentialRemoteStatus | null;
  readonly files: {
    readonly secret: LocalFileStatus;
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

interface IssuedCredential extends CredentialRemoteStatus {
  readonly organizationId: string;
  readonly scopes: typeof INTEGRATION_E2E_API_KEY_SCOPES;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly secret: string;
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
  const expectedKeyId = await deterministicIntegrationE2eApiKeyId(operationId).catch(() => {
    throw new IntegrationCredentialError("generated credential operation id is invalid");
  });
  const body = credentialAuthorityRequestBody({
    operationId,
    organizationId: prepared.authority.organizationId,
    scopes: INTEGRATION_E2E_API_KEY_SCOPES,
    ttlSeconds: prepared.keyLifetimeSeconds,
  });

  let issued: IssuedCredential;
  try {
    const response = await authorityRequest(prepared, privateJwk, "issue", body);
    issued = parseIssued(response, {
      operationId,
      keyId: expectedKeyId,
      organizationId: prepared.authority.organizationId,
      ttlSeconds: prepared.keyLifetimeSeconds,
    });
  } catch (error) {
    const reconciled = await reconcileLostIssue(prepared, privateJwk, body, expectedKeyId);
    if (reconciled === "absent") throw safeError(error);
    if (reconciled === "revoked") {
      throw new IntegrationCredentialError(
        "credential secret acknowledgement was lost; the exact key was revoked and a new operation is required",
        { cause: safeError(error) },
      );
    }
    throw new IntegrationCredentialError(
      "credential compensation is indeterminate; do not retry issue until signed status is available",
      { cause: safeError(error) },
    );
  }

  const metadata: CredentialMetadataDocument = {
    version: 2,
    kind: "takoserver.integration-e2e-credential@v2",
    origin: prepared.origin,
    environment: "integration",
    organizationId: prepared.authority.organizationId,
    sourceCommit: prepared.authority.sourceCommit,
    artifactDigest: prepared.authority.artifactDigest,
    publicWorkerVersionId: prepared.authority.publicWorkerVersionId,
    key: {
      name: WRITER_KEY_NAME,
      keyId: issued.keyId,
      operationId,
      scopes: INTEGRATION_E2E_API_KEY_SCOPES,
      ttlSeconds: prepared.keyLifetimeSeconds,
      createdAt: issued.createdAt,
      expiresAt: issued.expiresAt,
      secretPath: paths.secret,
    },
  };

  try {
    // Publish the nonsecret recovery coordinates first. If the process stops
    // before the secret appears, a later signed status/revoke can still name
    // the exact operation; the inverse order could strand an unaddressable key.
    await atomicWriteMetadata(paths.metadata, metadata);
    assertPublishedMetadata(paths.metadata, metadata);
    await prepared.writeSecret(paths.secret, issued.secret);
    assertPublishedSecret(paths.secret, issued.secret);
    return metadata;
  } catch (error) {
    const absent = await revokeAndProveAbsence(prepared, privateJwk, body, expectedKeyId);
    const filesRemoved = await removeCredentialFiles(paths, prepared.removeFile);
    if (!absent || !filesRemoved) {
      throw new IntegrationCredentialError(
        "credential compensation is indeterminate; inspect the exact key and local files before continuing",
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
      kind: "takoserver.integration-e2e-credential-status@v2",
      origin: prepared.origin,
      organizationId: prepared.authority.organizationId,
      keyId: "",
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
  const remote = parseStatus(response, body, metadata.key.keyId);
  return {
    kind: "takoserver.integration-e2e-credential-status@v2",
    origin: prepared.origin,
    organizationId: prepared.authority.organizationId,
    keyId: metadata.key.keyId,
    remote,
    files: fileStatuses(paths),
  };
}

/** Revoke once, then require a separate signed status response before deleting local files. */
export async function revokeIntegrationCredentials(
  options: CredentialClientOptions,
): Promise<{ readonly organizationId: string; readonly keyId: string; readonly absent: true }> {
  const prepared = prepareOptions(options);
  const paths = credentialPaths(prepared.outputDirectory);
  const metadata = readMetadata(paths.metadata);
  await assertMetadataMatches(metadata, prepared, paths);
  const privateJwk = await readAndValidatePrivateJwk(
    prepared.privateJwkPath,
    prepared.authority.publicJwk,
  );
  const body = requestBodyFromMetadata(metadata);

  // Revoke is server-idempotent, but this invocation still sends it once. A
  // lost acknowledgement is settled by the following signed status request.
  await authorityRequest(prepared, privateJwk, "revoke", body).catch(() => null);
  const statusResponse = await authorityRequest(prepared, privateJwk, "status", body);
  const status = parseStatus(statusResponse, body, metadata.key.keyId);
  if (status.present) {
    throw new IntegrationCredentialError(
      "credential revoke is incomplete because signed status still reports the exact key present",
    );
  }
  if (!(await removeCredentialFiles(paths, prepared.removeFile))) {
    throw new IntegrationCredentialError(
      "credential revoke succeeded but local file cleanup failed",
    );
  }
  return {
    organizationId: metadata.organizationId,
    keyId: metadata.key.keyId,
    absent: true,
  };
}

export function credentialPaths(outputDirectory: string): CredentialPaths {
  return {
    secret: join(outputDirectory, "task-0037-integration-writer.secret"),
    metadata: join(outputDirectory, "task-0037-integration-writer.json"),
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
  if (
    !Number.isSafeInteger(keyLifetimeSeconds) ||
    keyLifetimeSeconds <= 0 ||
    keyLifetimeSeconds > INTEGRATION_E2E_API_KEY_MAX_TTL_SECONDS
  ) {
    throw new IntegrationCredentialError("API-key lifetime is outside its bounded range");
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
  expectedKeyId: string,
): Promise<"absent" | "revoked" | "indeterminate"> {
  let status: CredentialRemoteStatus;
  try {
    status = parseStatus(
      await authorityRequest(prepared, privateJwk, "status", body),
      body,
      expectedKeyId,
    );
  } catch {
    return "indeterminate";
  }
  if (!status.present) return "absent";
  return (await revokeAndProveAbsence(prepared, privateJwk, body, expectedKeyId))
    ? "revoked"
    : "indeterminate";
}

async function revokeAndProveAbsence(
  prepared: PreparedOptions,
  privateJwk: Readonly<Record<string, unknown>>,
  body: ReturnType<typeof credentialAuthorityRequestBody>,
  expectedKeyId: string,
): Promise<boolean> {
  await authorityRequest(prepared, privateJwk, "revoke", body).catch(() => null);
  try {
    const status = parseStatus(
      await authorityRequest(prepared, privateJwk, "status", body),
      body,
      expectedKeyId,
    );
    return !status.present;
  } catch {
    return false;
  }
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
  expected: {
    readonly operationId: string;
    readonly keyId: string;
    readonly organizationId: string;
    readonly ttlSeconds: number;
  },
): IssuedCredential {
  if (response.status !== 201) {
    throw new IntegrationCredentialError(
      `credential issue returned status ${response.status}${safeResponseCode(response.body)}`,
    );
  }
  const value = responseRecord(response.body);
  const status = parseStatusValue(value, expected.operationId, expected.keyId, true);
  const secret = value.secret;
  if (
    !status.present ||
    !status.usable ||
    status.organizationId !== expected.organizationId ||
    JSON.stringify(status.scopes) !== JSON.stringify(INTEGRATION_E2E_API_KEY_SCOPES) ||
    typeof status.createdAt !== "string" ||
    typeof status.expiresAt !== "string" ||
    Date.parse(status.expiresAt) - Date.parse(status.createdAt) !== expected.ttlSeconds * 1_000 ||
    typeof secret !== "string" ||
    secret.length < 16 ||
    secret.length > 512
  ) {
    throw new IntegrationCredentialError(
      "credential issue response does not match the exact request",
    );
  }
  return {
    ...status,
    organizationId: status.organizationId,
    scopes: INTEGRATION_E2E_API_KEY_SCOPES,
    createdAt: status.createdAt,
    expiresAt: status.expiresAt,
    secret,
  };
}

function parseStatus(
  response: { readonly status: number; readonly body: unknown },
  request: ReturnType<typeof credentialAuthorityRequestBody>,
  keyId: string,
): CredentialRemoteStatus {
  if (response.status !== 200) {
    throw new IntegrationCredentialError(
      `credential status returned status ${response.status}${safeResponseCode(response.body)}`,
    );
  }
  const status = parseStatusValue(responseRecord(response.body), request.operationId, keyId);
  if (
    (status.organizationId !== undefined && status.organizationId !== request.organizationId) ||
    (status.scopes !== undefined &&
      JSON.stringify(status.scopes) !== JSON.stringify(INTEGRATION_E2E_API_KEY_SCOPES)) ||
    (status.createdAt !== undefined &&
      status.expiresAt !== undefined &&
      Date.parse(status.expiresAt) - Date.parse(status.createdAt) !== request.ttlSeconds * 1_000)
  ) {
    throw new IntegrationCredentialError("credential status does not match the exact request");
  }
  return status;
}

function parseStatusValue(
  value: Readonly<Record<string, unknown>>,
  operationId: string,
  keyId: string,
  allowSecret = false,
): CredentialRemoteStatus {
  const baseKeys = ["keyId", "kind", "operationId", "present", "usable"] as const;
  const detailKeys = ["createdAt", "expiresAt", "organizationId", "scopes"] as const;
  const hasAnyDetails = detailKeys.some((key) => key in value);
  const hasAllDetails = detailKeys.every((key) => key in value);
  const expectedKeys = [
    ...baseKeys,
    ...(hasAllDetails ? detailKeys : []),
    ...(allowSecret ? ["secret"] : []),
  ];
  if (
    hasAnyDetails !== hasAllDetails ||
    !exactKeys(value, expectedKeys) ||
    value.kind !== "takoserver.integration-e2e-api-key-status@v1" ||
    value.operationId !== operationId ||
    value.keyId !== keyId ||
    typeof value.present !== "boolean" ||
    typeof value.usable !== "boolean" ||
    (value.usable && !value.present) ||
    (value.present && !hasAllDetails)
  ) {
    throw new IntegrationCredentialError("credential status response is malformed");
  }
  if (
    hasAllDetails &&
    (typeof value.organizationId !== "string" ||
      !Array.isArray(value.scopes) ||
      !value.scopes.every((scope) => typeof scope === "string") ||
      typeof value.createdAt !== "string" ||
      !isCanonicalInstant(value.createdAt) ||
      typeof value.expiresAt !== "string" ||
      !isCanonicalInstant(value.expiresAt))
  ) {
    throw new IntegrationCredentialError("credential status response is malformed");
  }
  const optional = {
    ...(typeof value.organizationId === "string" ? { organizationId: value.organizationId } : {}),
    ...(Array.isArray(value.scopes) && value.scopes.every((scope) => typeof scope === "string")
      ? { scopes: value.scopes as readonly string[] }
      : {}),
    ...(typeof value.createdAt === "string" ? { createdAt: value.createdAt } : {}),
    ...(typeof value.expiresAt === "string" ? { expiresAt: value.expiresAt } : {}),
  };
  return {
    keyId,
    operationId,
    present: value.present,
    usable: value.usable,
    ...optional,
  };
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
  for (const path of [paths.secret, paths.metadata]) {
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
  let complete = true;
  for (const path of [paths.secret, paths.metadata]) {
    if (!existsSync(path)) continue;
    try {
      assertOwnedRegular(path, "credential file");
      await remove(path);
      if (existsSync(path)) complete = false;
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
  return existsSync(path) ? readMetadata(path) : null;
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
      "artifactDigest",
      "environment",
      "key",
      "kind",
      "organizationId",
      "origin",
      "publicWorkerVersionId",
      "sourceCommit",
      "version",
    ]) ||
    root.version !== 2 ||
    root.kind !== "takoserver.integration-e2e-credential@v2" ||
    root.environment !== "integration" ||
    typeof root.origin !== "string" ||
    typeof root.organizationId !== "string" ||
    typeof root.sourceCommit !== "string" ||
    typeof root.artifactDigest !== "string" ||
    typeof root.publicWorkerVersionId !== "string"
  ) {
    throw new IntegrationCredentialError("credential metadata is malformed");
  }
  const key = responseRecord(root.key);
  if (
    !exactKeys(key, [
      "createdAt",
      "expiresAt",
      "keyId",
      "name",
      "operationId",
      "scopes",
      "secretPath",
      "ttlSeconds",
    ]) ||
    key.name !== WRITER_KEY_NAME ||
    typeof key.keyId !== "string" ||
    typeof key.operationId !== "string" ||
    JSON.stringify(key.scopes) !== JSON.stringify(INTEGRATION_E2E_API_KEY_SCOPES) ||
    !Number.isSafeInteger(key.ttlSeconds) ||
    typeof key.createdAt !== "string" ||
    !isCanonicalInstant(key.createdAt) ||
    typeof key.expiresAt !== "string" ||
    !isCanonicalInstant(key.expiresAt) ||
    typeof key.secretPath !== "string"
  ) {
    throw new IntegrationCredentialError("credential metadata key is malformed");
  }
  return {
    version: 2,
    kind: "takoserver.integration-e2e-credential@v2",
    origin: root.origin,
    environment: "integration",
    organizationId: root.organizationId,
    sourceCommit: root.sourceCommit,
    artifactDigest: root.artifactDigest as `sha256:${string}`,
    publicWorkerVersionId: root.publicWorkerVersionId,
    key: {
      name: WRITER_KEY_NAME,
      keyId: key.keyId,
      operationId: key.operationId,
      scopes: INTEGRATION_E2E_API_KEY_SCOPES,
      ttlSeconds: key.ttlSeconds as number,
      createdAt: key.createdAt,
      expiresAt: key.expiresAt,
      secretPath: key.secretPath,
    },
  };
}

async function assertMetadataMatches(
  metadata: CredentialMetadataDocument,
  prepared: PreparedOptions,
  paths: CredentialPaths,
): Promise<void> {
  const expectedKeyId = await deterministicIntegrationE2eApiKeyId(metadata.key.operationId).catch(
    () => null,
  );
  if (
    metadata.origin !== prepared.origin ||
    metadata.environment !== "integration" ||
    metadata.organizationId !== prepared.authority.organizationId ||
    metadata.sourceCommit !== prepared.authority.sourceCommit ||
    metadata.artifactDigest !== prepared.authority.artifactDigest ||
    metadata.publicWorkerVersionId !== prepared.authority.publicWorkerVersionId ||
    expectedKeyId === null ||
    metadata.key.keyId !== expectedKeyId ||
    metadata.key.secretPath !== paths.secret ||
    metadata.key.ttlSeconds <= 0 ||
    metadata.key.ttlSeconds > INTEGRATION_E2E_API_KEY_MAX_TTL_SECONDS ||
    Date.parse(metadata.key.expiresAt) - Date.parse(metadata.key.createdAt) !==
      metadata.key.ttlSeconds * 1_000
  ) {
    throw new IntegrationCredentialError("credential metadata does not match exact live routing");
  }
}

function requestBodyFromMetadata(metadata: CredentialMetadataDocument) {
  return credentialAuthorityRequestBody({
    operationId: metadata.key.operationId,
    organizationId: metadata.organizationId,
    scopes: INTEGRATION_E2E_API_KEY_SCOPES,
    ttlSeconds: metadata.key.ttlSeconds,
  });
}

function fileStatuses(paths: CredentialPaths): CredentialStatus["files"] {
  return { secret: localFileStatus(paths.secret), metadata: localFileStatus(paths.metadata) };
}

function localFileStatus(path: string): LocalFileStatus {
  try {
    const stat = lstatSync(path);
    return { path, exists: true, mode: stat.mode & 0o777, symlink: stat.isSymbolicLink() };
  } catch {
    return { path, exists: false, mode: null, symlink: false };
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
  // Every result type is nonsecret. Assertions and the one-time API-key secret
  // exist only in request memory and the owner-only secret file.
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await cli().catch((error: unknown) => {
    process.stderr.write(`${safeError(error).message}\n`);
    process.exitCode = 1;
  });
}
