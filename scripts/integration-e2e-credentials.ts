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

import { API_KEY_SCOPES, type ApiKeyScope } from "../src/auth.ts";
import { signOperatorAssertion } from "../src/operator-key.ts";
import type { DeployTarget } from "./deploy/target.ts";
import { loadTarget } from "./deploy/target.ts";

/**
 * The disposable credential pair used by the TASK-0037 integration proof.
 *
 * This helper intentionally lives beside the integration checkout rather than
 * in the Worker or its deploy entrypoint.  It is an ordinary HTTP client: the
 * only authority it has is the short-lived operator assertion, and all account
 * mutations go through the public owner routes.
 */

export const FIXTURE_ORGANIZATION_NAME = "TASK-0037 Integration E2E";
export const WRITER_KEY_NAME = "TASK-0037 integration writer";
export const READER_KEY_NAME = "TASK-0037 integration reader";
export const KEY_TTL_SECONDS = 3_600;
export const OPERATOR_ASSERTION_TTL_SECONDS = 600;

export const TARGET_ENVIRONMENT_VARIABLE = "TAKOSERVER_DEPLOY_TARGET_INTEGRATION";
export const PRIVATE_JWK_ENVIRONMENT_VARIABLE = "TAKOSERVER_OPERATOR_PRIVATE_JWK_PATH";
export const OUTPUT_DIRECTORY_ENVIRONMENT_VARIABLE = "TAKOSERVER_INTEGRATION_E2E_OUTPUT_DIRECTORY";

export const WRITER_SCOPES = ["resources:write"] as const;
export const READER_SCOPES = ["resources:read"] as const;
const PRIVATE_KEYS = ["kty", "crv", "x", "d", "ext", "key_ops"] as const;
const BASE64URL_32 = /^[A-Za-z0-9_-]{43}$/u;
const MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_LOCAL_FILE_BYTES = 64 * 1024;
const PRIVATE_MODE = 0o600;

type KeyScope = ApiKeyScope;

export interface CredentialFileMetadata {
  readonly name: string;
  readonly path: string;
  readonly keyId: string;
  readonly organizationId: string;
  readonly scopes: readonly KeyScope[];
  readonly createdAt: string;
  readonly expiresAt: string;
}

export interface CredentialMetadataDocument {
  readonly version: 1;
  readonly kind: "takoserver.integration-e2e-credentials@v1";
  readonly origin: string;
  readonly organizationId: string;
  readonly organizationName: string;
  readonly keys: readonly CredentialFileMetadata[];
}

export interface CredentialPaths {
  readonly writer: string;
  readonly reader: string;
  readonly metadata: string;
}

export interface CredentialHttpResponse {
  readonly status: number;
  readonly body: unknown;
}

export type CredentialFetcher = (input: string, init?: RequestInit) => Promise<Response>;

export interface CredentialClientOptions {
  readonly origin: string;
  readonly target: DeployTarget;
  readonly privateJwkPath: string;
  readonly outputDirectory: string;
  readonly fetcher?: CredentialFetcher;
  readonly now?: () => Date;
  readonly assertionLifetimeSeconds?: number;
  readonly keyLifetimeSeconds?: number;
  /** Test-only hook; production uses atomic filesystem writes below. */
  readonly writeSecret?: (path: string, secret: string) => Promise<void>;
  /** Test-only hook; production uses unlink after an acknowledgement. */
  readonly removeFile?: (path: string) => Promise<void>;
}

export interface CredentialStatus {
  readonly kind: "takoserver.integration-e2e-credentials-status@v1";
  readonly origin: string;
  readonly organizationId: string;
  readonly organizationName: string;
  readonly files: readonly {
    readonly name: string;
    readonly keyId: string;
    readonly path: string;
    readonly exists: boolean;
    readonly mode: number | null;
    readonly symlink: boolean;
  }[];
  readonly metadata: {
    readonly path: string;
    readonly exists: boolean;
    readonly mode: number | null;
    readonly symlink: boolean;
  };
}

export class IntegrationCredentialError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    // Never interpolate an assertion, bearer, API-key secret, or response body
    // into this message.  Callers may safely print it to a report.
    super(redactSecrets(message), options);
    this.name = "IntegrationCredentialError";
  }
}

/**
 * Issue the exact writer/reader pair and persist their one-time secrets.
 *
 * The operation is deliberately compensating: once an API key is acknowledged,
 * every later failure first revokes all keys created by this invocation and
 * then revokes the temporary session.  A pre-existing fixture is never
 * changed, and a failed file write therefore cannot leave a live credential.
 */
export async function issueIntegrationCredentials(
  options: CredentialClientOptions,
): Promise<CredentialMetadataDocument> {
  const prepared = prepareOptions(options);
  const { origin, target, privateJwkPath, outputDirectory, fetcher, now } = prepared;
  const paths = credentialPaths(outputDirectory);
  assertIssueDestinationsVacant(paths);
  const privateJwk = await readAndValidatePrivateJwk(privateJwkPath, target);
  const assertion = await signOperatorAssertion({
    privateJwk: JSON.stringify(privateJwk),
    claims: {
      purpose: "sign-in",
      provider: "google",
      subject: "task-0037-integration-operator",
      email: "task-0037-integration-operator@localhost",
      displayName: "TASK-0037 Integration Operator",
    },
    nowSeconds: Math.floor(now().getTime() / 1_000),
    lifetimeSeconds: prepared.assertionLifetimeSeconds,
  });

  let sessionToken: string | null = null;
  let organizationId: string | null = null;
  const createdKeys: CreatedKeyRef[] = [];
  const pendingCreates: PendingCreate[] = [];
  const writtenFiles: string[] = [];
  try {
    const session = await httpJson(fetcher, origin, "/v1/sessions", {
      method: "POST",
      body: { provider: "google", method: "operator-assertion", assertion },
    });
    sessionToken = requiredString(session.body, ["sessionToken"]);
    const auth = bearer(sessionToken);

    const me = await httpJson(fetcher, origin, "/v1/me", {
      method: "GET",
      headers: auth,
    });
    const principal = record(me.body).principal;
    if (!principal || typeof principal !== "object" || Array.isArray(principal)) {
      throw new IntegrationCredentialError("/v1/me did not return a principal");
    }
    const organizations = exactOrganizations(me.body);
    const matches = organizations.filter((item) => item.name === FIXTURE_ORGANIZATION_NAME);
    if (matches.length > 1) {
      throw new IntegrationCredentialError("fixture organization metadata is duplicated");
    }
    let organization = matches[0];
    if (!organization) {
      if (organizations.some((item) => item.id === FIXTURE_ORGANIZATION_NAME)) {
        throw new IntegrationCredentialError("fixture organization metadata is ambiguous");
      }
      const created = await httpJson(fetcher, origin, "/v1/organizations", {
        method: "POST",
        headers: { ...auth, "content-type": "application/json" },
        body: { name: FIXTURE_ORGANIZATION_NAME },
      });
      organization = exactOrganization(created.body);
      if (organization.name !== FIXTURE_ORGANIZATION_NAME) {
        throw new IntegrationCredentialError("fixture organization response has the wrong name");
      }
    }
    organizationId = organization.id;

    const existingKeys = await listKeys(fetcher, origin, organization.id, auth);
    const knownKeyIds = new Set(existingKeys.map((key) => key.id));
    const exactKeys = exactNamedKeys(existingKeys);
    for (const name of [WRITER_KEY_NAME, READER_KEY_NAME]) {
      const count = exactKeys.filter((key) => key.name === name).length;
      if (count > 1) {
        throw new IntegrationCredentialError("fixture API-key metadata is duplicated");
      }
      if (count === 1) {
        throw new IntegrationCredentialError("fixture API-key metadata already exists");
      }
    }

    const writer = await createAndTrackKey(
      fetcher,
      origin,
      organization.id,
      WRITER_KEY_NAME,
      WRITER_SCOPES,
      prepared.keyLifetimeSeconds,
      auth,
      knownKeyIds,
      createdKeys,
      pendingCreates,
    );
    const reader = await createAndTrackKey(
      fetcher,
      origin,
      organization.id,
      READER_KEY_NAME,
      READER_SCOPES,
      prepared.keyLifetimeSeconds,
      auth,
      knownKeyIds,
      createdKeys,
      pendingCreates,
    );

    await persistAndTrack(paths.writer, writer.secret, prepared.writeSecret, writtenFiles);
    await persistAndTrack(paths.reader, reader.secret, prepared.writeSecret, writtenFiles);
    const metadata: CredentialMetadataDocument = {
      version: 1,
      kind: "takoserver.integration-e2e-credentials@v1",
      origin,
      organizationId: organization.id,
      organizationName: FIXTURE_ORGANIZATION_NAME,
      keys: [fileMetadata(paths.writer, writer), fileMetadata(paths.reader, reader)],
    };
    await persistMetadataAndTrack(paths.metadata, metadata, writtenFiles);

    await revokeSessionAndVerify(fetcher, origin, sessionToken);
    sessionToken = null;
    return metadata;
  } catch (error) {
    const primary = safeError(error);
    const compensation = await compensate(
      fetcher,
      origin,
      sessionToken,
      organizationId,
      createdKeys,
      pendingCreates,
      writtenFiles,
      prepared.removeFile,
    );
    if (!compensation.complete) {
      throw new IntegrationCredentialError(
        "credential compensation is indeterminate; inspect and revoke the fixture before retrying",
        { cause: primary },
      );
    }
    throw primary;
  }
}

/** Revoke exactly the metadata-described pair, then remove only owned files. */
export async function revokeIntegrationCredentials(
  options: CredentialClientOptions,
): Promise<{ readonly organizationId: string; readonly removed: readonly string[] }> {
  const prepared = prepareOptions(options);
  const paths = credentialPaths(prepared.outputDirectory);
  const metadata = readMetadata(paths.metadata);
  if (metadata.origin !== prepared.origin) {
    throw new IntegrationCredentialError("credential metadata origin does not match target origin");
  }
  if (metadata.organizationName !== FIXTURE_ORGANIZATION_NAME) {
    throw new IntegrationCredentialError("credential metadata organization does not match fixture");
  }
  assertMetadataPaths(metadata, paths);
  const privateJwk = await readAndValidatePrivateJwk(prepared.privateJwkPath, prepared.target);
  const assertion = await signOperatorAssertion({
    privateJwk: JSON.stringify(privateJwk),
    claims: {
      purpose: "sign-in",
      provider: "google",
      subject: "task-0037-integration-operator",
      email: "task-0037-integration-operator@localhost",
      displayName: "TASK-0037 Integration Operator",
    },
    nowSeconds: Math.floor(prepared.now().getTime() / 1_000),
    lifetimeSeconds: prepared.assertionLifetimeSeconds,
  });
  let sessionToken: string | null = null;
  try {
    const session = await httpJson(prepared.fetcher, prepared.origin, "/v1/sessions", {
      method: "POST",
      body: { provider: "google", method: "operator-assertion", assertion },
    });
    sessionToken = requiredString(session.body, ["sessionToken"]);
    const auth = bearer(sessionToken);
    const me = await httpJson(prepared.fetcher, prepared.origin, "/v1/me", {
      method: "GET",
      headers: auth,
    });
    const organizations = exactOrganizations(me.body);
    const fixture = organizations.filter(
      (organization) => organization.id === metadata.organizationId,
    );
    if (fixture.length !== 1 || fixture[0]?.name !== FIXTURE_ORGANIZATION_NAME) {
      throw new IntegrationCredentialError("fixture organization metadata is missing or ambiguous");
    }
    const liveKeys = await listKeys(
      prepared.fetcher,
      prepared.origin,
      metadata.organizationId,
      auth,
    );
    const byName = exactNamedKeys(liveKeys);
    const liveOwnedKeys: ApiKeyMetadata[] = [];
    for (const expected of metadata.keys) {
      const matches = byName.filter((key) => key.name === expected.name);
      if (matches.length > 1) {
        throw new IntegrationCredentialError("fixture API-key metadata is duplicated");
      }
      const actual = matches[0];
      if (!actual) continue;
      if (actual.id !== expected.keyId || !sameScopes(actual.scopes, expected.scopes)) {
        throw new IntegrationCredentialError("fixture API-key metadata does not match live keys");
      }
      liveOwnedKeys.push(actual);
    }
    for (const expected of liveOwnedKeys) {
      await httpJson(
        prepared.fetcher,
        prepared.origin,
        `/v1/organizations/${encodeURIComponent(metadata.organizationId)}/api-keys/${encodeURIComponent(expected.id)}`,
        { method: "DELETE", headers: { ...auth, "content-type": "application/json" } },
      );
    }
    const remaining = await listKeys(
      prepared.fetcher,
      prepared.origin,
      metadata.organizationId,
      auth,
    );
    if (remaining.some((key) => byName.some((old) => old.id === key.id))) {
      throw new IntegrationCredentialError("fixture API-key revocation was not durable");
    }
    await revokeSessionAndVerify(prepared.fetcher, prepared.origin, sessionToken);
    sessionToken = null;
    const removed: string[] = [];
    for (const path of [paths.writer, paths.reader, paths.metadata]) {
      await removeOwnedFile(path, prepared.removeFile);
      removed.push(path);
    }
    return { organizationId: metadata.organizationId, removed };
  } catch (error) {
    if (sessionToken !== null) {
      const revoked = await safeRevokeSession(prepared.fetcher, prepared.origin, sessionToken);
      if (!revoked) {
        throw new IntegrationCredentialError(
          "temporary session cleanup is indeterminate; inspect the fixture before retrying",
          { cause: safeError(error) },
        );
      }
    }
    throw safeError(error);
  }
}

/** Read-only local status; no assertion, session, or network mutation occurs. */
export function statusIntegrationCredentials(
  options: Pick<
    CredentialClientOptions,
    "origin" | "target" | "privateJwkPath" | "outputDirectory"
  >,
): CredentialStatus {
  const prepared = prepareOptions({ ...options, fetcher: fetch });
  const paths = credentialPaths(prepared.outputDirectory);
  const metadata = readMetadataIfPresent(paths.metadata);
  const files = [
    {
      name: WRITER_KEY_NAME,
      keyId: metadata?.keys.find((key) => key.name === WRITER_KEY_NAME)?.keyId ?? "",
      path: paths.writer,
    },
    {
      name: READER_KEY_NAME,
      keyId: metadata?.keys.find((key) => key.name === READER_KEY_NAME)?.keyId ?? "",
      path: paths.reader,
    },
  ].map((file) => localFileStatus(file));
  return {
    kind: "takoserver.integration-e2e-credentials-status@v1",
    origin: prepared.origin,
    organizationId: metadata?.organizationId ?? "",
    organizationName: metadata?.organizationName ?? FIXTURE_ORGANIZATION_NAME,
    files,
    metadata: localFileStatus({ name: "metadata", keyId: "", path: paths.metadata }),
  };
}

export function credentialPaths(outputDirectory: string): CredentialPaths {
  return {
    writer: join(outputDirectory, "task-0037-integration-writer.secret"),
    reader: join(outputDirectory, "task-0037-integration-reader.secret"),
    metadata: join(outputDirectory, "task-0037-integration-credentials.json"),
  };
}

function assertIssueDestinationsVacant(paths: CredentialPaths): void {
  for (const path of [paths.writer, paths.reader, paths.metadata]) {
    try {
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) {
        throw new IntegrationCredentialError("credential destination may not be a symlink");
      }
      throw new IntegrationCredentialError("credential destination already exists");
    } catch (error) {
      if (error instanceof IntegrationCredentialError) throw error;
      // ENOENT is the only acceptable preflight result. Other filesystem
      // failures (permission, I/O, and so on) must fail closed.
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        throw new IntegrationCredentialError("credential destination cannot be inspected");
      }
    }
  }
}

export function loadIntegrationEnvironment(environment: NodeJS.ProcessEnv = process.env): {
  readonly targetPath: string;
  readonly privateJwkPath: string;
  readonly outputDirectory: string;
} {
  const targetPath = requiredEnvironment(environment, TARGET_ENVIRONMENT_VARIABLE);
  const privateJwkPath = requiredEnvironment(environment, PRIVATE_JWK_ENVIRONMENT_VARIABLE);
  const outputDirectory = requiredEnvironment(environment, OUTPUT_DIRECTORY_ENVIRONMENT_VARIABLE);
  return { targetPath, privateJwkPath, outputDirectory };
}

async function cli(): Promise<void> {
  const action = process.argv[2];
  if (action !== "issue" && action !== "revoke" && action !== "status") {
    throw new IntegrationCredentialError(
      "usage: integration-e2e-credentials.ts <issue|revoke|status>",
    );
  }
  const environment = loadIntegrationEnvironment();
  const target = loadTarget(environment.targetPath, "integration");
  const options = {
    origin: target.publicOrigin,
    target,
    privateJwkPath: environment.privateJwkPath,
    outputDirectory: environment.outputDirectory,
  } satisfies CredentialClientOptions;
  const result =
    action === "issue"
      ? await issueIntegrationCredentials(options)
      : action === "revoke"
        ? await revokeIntegrationCredentials(options)
        : statusIntegrationCredentials(options);
  // This JSON contains metadata only. Secrets, assertions, bearer sessions,
  // and private key members are never printed.
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

function prepareOptions(options: CredentialClientOptions): Required<CredentialClientOptions> {
  if (options.target.environment !== "integration") {
    throw new IntegrationCredentialError(
      "integration credential helper requires an integration target",
    );
  }
  const origin = httpsOrigin(options.origin);
  if (options.target.publicOrigin !== origin) {
    throw new IntegrationCredentialError("integration origin does not match deploy target");
  }
  const privateJwkPath = validatePrivatePath(options.privateJwkPath);
  const outputDirectory = validateOutputDirectory(options.outputDirectory);
  const now = options.now ?? (() => new Date());
  const assertionLifetimeSeconds =
    options.assertionLifetimeSeconds ?? OPERATOR_ASSERTION_TTL_SECONDS;
  const keyLifetimeSeconds = options.keyLifetimeSeconds ?? KEY_TTL_SECONDS;
  if (
    !Number.isSafeInteger(assertionLifetimeSeconds) ||
    assertionLifetimeSeconds <= 0 ||
    assertionLifetimeSeconds > 900
  ) {
    throw new IntegrationCredentialError(
      "operator assertion lifetime is outside its bounded range",
    );
  }
  if (
    !Number.isSafeInteger(keyLifetimeSeconds) ||
    keyLifetimeSeconds <= 0 ||
    keyLifetimeSeconds > 86_400
  ) {
    throw new IntegrationCredentialError("API-key lifetime is outside its bounded range");
  }
  return {
    origin,
    target: options.target,
    privateJwkPath,
    outputDirectory,
    fetcher: options.fetcher ?? fetch,
    now,
    assertionLifetimeSeconds,
    keyLifetimeSeconds,
    writeSecret: options.writeSecret ?? atomicWriteSecret,
    removeFile: options.removeFile ?? removeFile,
  };
}

async function readAndValidatePrivateJwk(
  path: string,
  target: DeployTarget,
): Promise<Record<string, unknown>> {
  const raw = readOwnedRegular(path, "operator private JWK");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new IntegrationCredentialError("operator private JWK is not valid JSON");
  }
  if (!isRecord(parsed) || !exactKeys(parsed, PRIVATE_KEYS)) {
    throw new IntegrationCredentialError("operator private JWK has unexpected or missing members");
  }
  if (
    parsed.kty !== "OKP" ||
    parsed.crv !== "Ed25519" ||
    parsed.ext !== true ||
    !Array.isArray(parsed.key_ops) ||
    JSON.stringify(parsed.key_ops) !== JSON.stringify(["sign"]) ||
    typeof parsed.x !== "string" ||
    !BASE64URL_32.test(parsed.x) ||
    typeof parsed.d !== "string" ||
    !BASE64URL_32.test(parsed.d)
  ) {
    throw new IntegrationCredentialError(
      "operator private JWK must be one exact Ed25519 signing key",
    );
  }
  const publicJwk = target.operatorIdentity?.publicJwk;
  if (!publicJwk || parsed.x !== publicJwk.x) {
    throw new IntegrationCredentialError("operator private JWK does not match target public JWK");
  }
  try {
    const privateKey = await awaitImportKey(parsed, ["sign"]);
    const publicKey = await awaitImportKey(publicJwk, ["verify"]);
    const message = new TextEncoder().encode("takoserver.integration-e2e-credentials@v1");
    const signature = await crypto.subtle.sign("Ed25519", privateKey, message);
    if (!(await crypto.subtle.verify("Ed25519", publicKey, signature, message))) throw new Error();
  } catch {
    throw new IntegrationCredentialError("operator private JWK cannot prove target public JWK");
  }
  return parsed;
}

function awaitImportKey(jwk: Record<string, unknown>, usages: KeyUsage[]): Promise<CryptoKey> {
  return crypto.subtle.importKey("jwk", jwk, { name: "Ed25519" }, false, usages);
}

function validatePrivatePath(path: string): string {
  if (path.trim() !== path || path.length === 0) {
    throw new IntegrationCredentialError("operator private JWK path is required");
  }
  return validateLinkFreePath(resolve(path), false, "operator private JWK");
}

function validateOutputDirectory(path: string): string {
  if (!isAbsolute(path))
    throw new IntegrationCredentialError("credential output directory must be absolute");
  const normalized = validateLinkFreePath(path, true, "credential output directory");
  if (isInsideRepository(normalized)) {
    throw new IntegrationCredentialError(
      "credential output directory must be outside every Git repository",
    );
  }
  const stat = lstatSync(normalized);
  if (!stat.isDirectory())
    throw new IntegrationCredentialError("credential output path is not a directory");
  if ((stat.mode & 0o022) !== 0) {
    throw new IntegrationCredentialError(
      "credential output directory must not be group/world writable",
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
      throw new IntegrationCredentialError(`${label} path may not contain symlinks`);
    if (!stat.isDirectory() && current !== normalized) {
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
    if (!stat.isFile() || stat.nlink !== 1) {
      throw new IntegrationCredentialError(`${label} must be a link-free regular file`);
    }
    if ((stat.mode & 0o777) !== PRIVATE_MODE)
      throw new IntegrationCredentialError(`${label} must have mode 0600`);
    if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
      throw new IntegrationCredentialError(`${label} must be owned by the invoking user`);
    }
    const raw = readFileSync(fd, "utf8");
    if (raw.length > MAX_LOCAL_FILE_BYTES) {
      throw new IntegrationCredentialError(`${label} is too large`);
    }
    return raw;
  } catch (error) {
    if (error instanceof IntegrationCredentialError) throw error;
    throw new IntegrationCredentialError(`${label} cannot be read safely`);
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

function isInsideRepository(path: string): boolean {
  let current = path;
  while (true) {
    const marker = join(current, ".git");
    if (existsSync(marker)) return true;
    const parent = dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

async function httpJson(
  fetcher: CredentialFetcher,
  origin: string,
  pathname: string,
  options: {
    readonly method: string;
    readonly headers?: Record<string, string>;
    readonly body?: unknown;
  },
): Promise<CredentialHttpResponse> {
  const headers = {
    accept: "application/json",
    "cache-control": "no-store",
    ...(options.body === undefined ? {} : { "content-type": "application/json" }),
    ...(options.headers ?? {}),
  };
  let response: Response;
  try {
    response = await fetcher(new URL(pathname, `${origin}/`).toString(), {
      method: options.method,
      headers,
      redirect: "error",
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
  } catch {
    throw new IntegrationCredentialError(`HTTP ${options.method} ${pathname} failed`);
  }
  const text = await response.text();
  if (text.length > MAX_RESPONSE_BYTES) {
    throw new IntegrationCredentialError(
      `HTTP ${options.method} ${pathname} returned an oversized response`,
    );
  }
  let body: unknown = null;
  if (text.length > 0) {
    try {
      body = JSON.parse(text);
    } catch {
      throw new IntegrationCredentialError(
        `HTTP ${options.method} ${pathname} returned invalid JSON`,
      );
    }
  }
  if (!response.ok) {
    throw new IntegrationCredentialError(
      `HTTP ${options.method} ${pathname} returned status ${response.status}`,
    );
  }
  return { status: response.status, body };
}

async function listKeys(
  fetcher: CredentialFetcher,
  origin: string,
  organizationId: string,
  auth: Record<string, string>,
): Promise<ApiKeyMetadata[]> {
  const response = await httpJson(
    fetcher,
    origin,
    `/v1/organizations/${encodeURIComponent(organizationId)}/api-keys`,
    {
      method: "GET",
      headers: auth,
    },
  );
  const value = record(response.body).apiKeys;
  if (!Array.isArray(value))
    throw new IntegrationCredentialError("API-key list response is malformed");
  const keys = value.map(parseApiKeyMetadata);
  if (keys.some((key) => key.organizationId !== organizationId)) {
    throw new IntegrationCredentialError("API-key list response crossed organization boundary");
  }
  return keys;
}

async function createKey(
  fetcher: CredentialFetcher,
  origin: string,
  organizationId: string,
  name: string,
  scopes: readonly KeyScope[],
  expiresInSeconds: number,
  auth: Record<string, string>,
): Promise<CreatedKey> {
  const response = await httpJson(
    fetcher,
    origin,
    `/v1/organizations/${encodeURIComponent(organizationId)}/api-keys`,
    {
      method: "POST",
      headers: auth,
      body: { name, scopes, expiresInSeconds },
    },
  );
  const body = record(response.body);
  const apiKey = parseApiKeyMetadata(body.apiKey);
  if (
    apiKey.organizationId !== organizationId ||
    apiKey.name !== name ||
    !sameScopes(apiKey.scopes, scopes)
  ) {
    throw new IntegrationCredentialError("API-key create response does not match exact fixture");
  }
  const secret = body.secret;
  if (typeof secret !== "string" || secret.length === 0 || secret.length > 512) {
    throw new IntegrationCredentialError("API-key create response omitted its one-time secret");
  }
  return { ...apiKey, secret };
}

async function createAndTrackKey(
  fetcher: CredentialFetcher,
  origin: string,
  organizationId: string,
  name: string,
  scopes: readonly KeyScope[],
  expiresInSeconds: number,
  auth: Record<string, string>,
  knownKeyIds: Set<string>,
  createdKeys: CreatedKeyRef[],
  pendingCreates: PendingCreate[],
): Promise<CreatedKey> {
  const pending: PendingCreate = { name, knownKeyIds };
  try {
    const key = await createKey(
      fetcher,
      origin,
      organizationId,
      name,
      scopes,
      expiresInSeconds,
      auth,
    );
    createdKeys.push(key);
    knownKeyIds.add(key.id);
    return key;
  } catch (error) {
    try {
      for (const key of await reconcileUnknownKeys(
        fetcher,
        origin,
        organizationId,
        name,
        knownKeyIds,
        auth,
      )) {
        createdKeys.push(key);
        knownKeyIds.add(key.id);
      }
    } catch {
      pendingCreates.push(pending);
    }
    throw error;
  }
}

async function reconcileUnknownKeys(
  fetcher: CredentialFetcher,
  origin: string,
  organizationId: string,
  name: string,
  knownKeyIds: ReadonlySet<string>,
  auth: Record<string, string>,
): Promise<ApiKeyMetadata[]> {
  const liveKeys = await listKeys(fetcher, origin, organizationId, auth);
  return liveKeys.filter((key) => key.name === name && !knownKeyIds.has(key.id));
}

async function safeReconcileUnknownKeys(
  fetcher: CredentialFetcher,
  origin: string,
  organizationId: string,
  pending: PendingCreate,
  auth: Record<string, string>,
): Promise<ApiKeyMetadata[] | null> {
  try {
    return await reconcileUnknownKeys(
      fetcher,
      origin,
      organizationId,
      pending.name,
      pending.knownKeyIds,
      auth,
    );
  } catch {
    return null;
  }
}

async function revokeSessionAndVerify(
  fetcher: CredentialFetcher,
  origin: string,
  sessionToken: string,
): Promise<void> {
  const auth = bearer(sessionToken);
  try {
    await httpJson(fetcher, origin, "/v1/session", { method: "DELETE", headers: auth });
  } catch {
    // A lost DELETE acknowledgement is settled by the replay below. A 401
    // proves the bearer is unusable regardless of the DELETE response.
  }
  try {
    await httpJson(fetcher, origin, "/v1/me", { method: "GET", headers: auth });
  } catch (error) {
    // A 401 is the required replay proof. Other failures are not proof of
    // revocation and are surfaced without exposing response material.
    if (error instanceof IntegrationCredentialError && error.message.includes("status 401")) return;
    throw new IntegrationCredentialError("session replay was not denied");
  }
  throw new IntegrationCredentialError("session replay was not denied");
}

async function compensate(
  fetcher: CredentialFetcher,
  origin: string,
  sessionToken: string | null,
  organizationId: string | null,
  createdKeys: readonly CreatedKeyRef[],
  pendingCreates: readonly PendingCreate[],
  writtenFiles: readonly string[],
  removeFile: (path: string) => Promise<void>,
): Promise<{ readonly complete: boolean }> {
  let complete = true;
  const auth = sessionToken === null ? null : bearer(sessionToken);
  const atRiskKeyIds = new Set(createdKeys.map((key) => key.id));
  if (auth !== null && organizationId !== null) {
    for (const pending of [...pendingCreates].reverse()) {
      const recovered = await safeReconcileUnknownKeys(
        fetcher,
        origin,
        organizationId,
        pending,
        auth,
      );
      if (recovered === null) {
        complete = false;
        continue;
      }
      for (const key of recovered) {
        atRiskKeyIds.add(key.id);
      }
    }
    for (const keyId of [...atRiskKeyIds].reverse()) {
      await safeRevokeKey(fetcher, origin, organizationId, keyId, auth);
    }
    try {
      const remaining = await listKeys(fetcher, origin, organizationId, auth);
      if (remaining.some((key) => atRiskKeyIds.has(key.id))) complete = false;
      for (const pending of pendingCreates) {
        if (
          remaining.some((key) => key.name === pending.name && !pending.knownKeyIds.has(key.id))
        ) {
          complete = false;
        }
      }
    } catch {
      complete = false;
    }
  } else if (createdKeys.length > 0 || pendingCreates.length > 0) {
    complete = false;
  }
  if (sessionToken !== null && !(await safeRevokeSession(fetcher, origin, sessionToken))) {
    complete = false;
  }
  for (const path of [...writtenFiles].reverse()) {
    if (!(await safeRemoveFile(path, removeFile))) complete = false;
  }
  return { complete };
}

async function safeRemoveFile(
  path: string,
  removeFile: (path: string) => Promise<void>,
): Promise<boolean> {
  try {
    await removeFile(path);
    return !existsSync(path);
  } catch {
    // Compensation must never mask the primary operation error.
    return false;
  }
}

async function safeRevokeKey(
  fetcher: CredentialFetcher,
  origin: string,
  organizationId: string,
  keyId: string,
  auth: Record<string, string>,
): Promise<void> {
  try {
    await httpJson(
      fetcher,
      origin,
      `/v1/organizations/${encodeURIComponent(organizationId)}/api-keys/${encodeURIComponent(keyId)}`,
      {
        method: "DELETE",
        headers: auth,
      },
    );
  } catch {
    // Compensation is best effort, but it must not mask the original failure
    // with a secret-bearing error. The caller receives the original safe error.
  }
}

async function safeRevokeSession(
  fetcher: CredentialFetcher,
  origin: string,
  sessionToken: string,
): Promise<boolean> {
  try {
    await revokeSessionAndVerify(fetcher, origin, sessionToken);
    return true;
  } catch {
    return false;
  }
}

async function persistSecret(
  path: string,
  secret: string,
  writer: (path: string, secret: string) => Promise<void>,
): Promise<void> {
  await writer(path, secret);
}

async function persistAndTrack(
  path: string,
  secret: string,
  writer: (path: string, secret: string) => Promise<void>,
  writtenFiles: string[],
): Promise<void> {
  try {
    await persistSecret(path, secret, writer);
    assertPublishedSecret(path, secret);
  } catch (error) {
    if (publishedSecretFile(path, secret)) writtenFiles.push(path);
    throw error;
  }
  writtenFiles.push(path);
}

function assertPublishedSecret(path: string, secret: string): void {
  let persisted: string;
  try {
    persisted = readOwnedRegular(path, "credential secret");
  } catch {
    throw new IntegrationCredentialError("credential secret publication could not be verified");
  }
  if (persisted !== `${secret}\n`) {
    throw new IntegrationCredentialError("credential secret publication was replaced");
  }
}

function publishedSecretFile(path: string, secret: string): boolean {
  try {
    return readOwnedRegular(path, "credential secret") === `${secret}\n`;
  } catch {
    return false;
  }
}

function publishNoReplace(temp: string, path: string, label: string): void {
  let linked = false;
  try {
    // rename(2) would replace a destination that appears after preflight. A
    // same-directory hard-link creates the destination atomically and refuses
    // EEXIST, so neither a race nor a symlink can be overwritten.
    linkSync(temp, path);
    linked = true;
    unlinkSync(temp);
  } catch (error) {
    if (linked) {
      try {
        unlinkSync(path);
      } catch {
        // Keep the original safe publication error.
      }
    }
    try {
      unlinkSync(temp);
    } catch {
      // Nothing to clean up.
    }
    if (error instanceof IntegrationCredentialError) throw error;
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new IntegrationCredentialError(`${label} destination already exists`);
    }
    throw new IntegrationCredentialError(`${label} publication failed`);
  }
}

async function atomicWriteSecret(path: string, secret: string): Promise<void> {
  assertOwnedDestination(path, "credential secret");
  const directory = dirname(path);
  const temp = join(directory, `.${basename(path)}.${crypto.randomUUID()}.tmp`);
  let fd: number | null = null;
  try {
    fd = openSync(temp, "wx", PRIVATE_MODE);
    writeFileSync(fd, `${secret}\n`, { encoding: "utf8" });
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    publishNoReplace(temp, path, "credential secret");
    const stat = lstatSync(path);
    if (
      stat.isSymbolicLink() ||
      !stat.isFile() ||
      stat.nlink !== 1 ||
      (stat.mode & 0o777) !== PRIVATE_MODE
    ) {
      throw new IntegrationCredentialError(
        "credential secret publication failed its mode/path check",
      );
    }
    const dirFd = openSync(directory, "r");
    try {
      fsyncSync(dirFd);
    } finally {
      closeSync(dirFd);
    }
  } catch (error) {
    if (fd !== null) closeSync(fd);
    try {
      unlinkSync(temp);
    } catch {
      // Nothing to clean up.
    }
    throw safeError(error);
  }
}

async function persistMetadata(path: string, metadata: CredentialMetadataDocument): Promise<void> {
  assertOwnedDestination(path, "credential metadata");
  const directory = dirname(path);
  const temp = join(directory, `.${basename(path)}.${crypto.randomUUID()}.tmp`);
  let fd: number | null = null;
  try {
    fd = openSync(temp, "wx", PRIVATE_MODE);
    writeFileSync(fd, `${JSON.stringify(metadata, null, 2)}\n`, { encoding: "utf8" });
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    publishNoReplace(temp, path, "credential metadata");
    const stat = lstatSync(path);
    if (
      stat.isSymbolicLink() ||
      !stat.isFile() ||
      stat.nlink !== 1 ||
      (stat.mode & 0o777) !== PRIVATE_MODE
    ) {
      throw new IntegrationCredentialError(
        "credential metadata publication failed its mode/path check",
      );
    }
    const dirFd = openSync(directory, "r");
    try {
      fsyncSync(dirFd);
    } finally {
      closeSync(dirFd);
    }
  } catch (error) {
    if (fd !== null) closeSync(fd);
    try {
      unlinkSync(temp);
    } catch {
      // Nothing to clean up.
    }
    throw safeError(error);
  }
}

async function persistMetadataAndTrack(
  path: string,
  metadata: CredentialMetadataDocument,
  writtenFiles: string[],
): Promise<void> {
  try {
    await persistMetadata(path, metadata);
    assertPublishedMetadata(path, metadata);
  } catch (error) {
    if (publishedMetadata(path, metadata)) writtenFiles.push(path);
    throw error;
  }
  writtenFiles.push(path);
}

function assertPublishedMetadata(path: string, metadata: CredentialMetadataDocument): void {
  try {
    const persisted = parseMetadata(readOwnedRegular(path, "credential metadata"));
    if (JSON.stringify(persisted) !== JSON.stringify(metadata)) {
      throw new Error("metadata publication was replaced");
    }
  } catch (error) {
    if (error instanceof IntegrationCredentialError) throw error;
    throw new IntegrationCredentialError("credential metadata publication was replaced");
  }
}

function publishedMetadata(path: string, metadata: CredentialMetadataDocument): boolean {
  try {
    return (
      JSON.stringify(parseMetadata(readOwnedRegular(path, "credential metadata"))) ===
      JSON.stringify(metadata)
    );
  } catch {
    return false;
  }
}

function assertOwnedDestination(path: string, label: string): void {
  const directory = validateLinkFreePath(dirname(path), true, `${label} parent`);
  if (isInsideRepository(directory))
    throw new IntegrationCredentialError(`${label} must be outside every Git repository`);
  if (join(directory, basename(path)) !== path)
    throw new IntegrationCredentialError(`${label} path is not canonical`);
}

async function removeOwnedFile(
  path: string,
  removeFile: (path: string) => Promise<void>,
): Promise<void> {
  if (!existsSync(path)) return;
  const normalized = validateLinkFreePath(path, false, "credential file");
  const stat = lstatSync(normalized);
  if (stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o777) !== PRIVATE_MODE) {
    throw new IntegrationCredentialError("credential file is not an owned 0600 regular file");
  }
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw new IntegrationCredentialError("credential file is not owned by the invoking user");
  }
  await removeFile(normalized);
}

async function removeFile(path: string): Promise<void> {
  unlinkSync(path);
}

function readMetadata(path: string): CredentialMetadataDocument {
  const raw = readOwnedRegular(path, "credential metadata");
  return parseMetadata(raw);
}

function readMetadataIfPresent(path: string): CredentialMetadataDocument | null {
  if (!existsSync(path)) return null;
  return readMetadata(path);
}

function parseMetadata(raw: string): CredentialMetadataDocument {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new IntegrationCredentialError("credential metadata is not valid JSON");
  }
  const root = record(value);
  if (
    !exactKeys(root, ["version", "kind", "origin", "organizationId", "organizationName", "keys"])
  ) {
    throw new IntegrationCredentialError("credential metadata has unexpected members");
  }
  if (
    root.version !== 1 ||
    root.kind !== "takoserver.integration-e2e-credentials@v1" ||
    typeof root.origin !== "string" ||
    !boundedSegment(root.organizationId) ||
    root.organizationName !== FIXTURE_ORGANIZATION_NAME ||
    !Array.isArray(root.keys) ||
    root.keys.length !== 2
  ) {
    throw new IntegrationCredentialError("credential metadata is malformed");
  }
  const keys = root.keys.map(parseFileMetadata);
  if (
    keys[0]?.name !== WRITER_KEY_NAME ||
    keys[1]?.name !== READER_KEY_NAME ||
    keys[0]?.scopes.length !== 1 ||
    keys[0]?.scopes[0] !== "resources:write" ||
    keys[1]?.scopes.length !== 1 ||
    keys[1]?.scopes[0] !== "resources:read" ||
    keys[0]?.organizationId !== root.organizationId ||
    keys[1]?.organizationId !== root.organizationId ||
    keys[0]?.keyId === keys[1]?.keyId
  ) {
    throw new IntegrationCredentialError("credential metadata key names are not exact");
  }
  return {
    version: 1,
    kind: "takoserver.integration-e2e-credentials@v1",
    origin: root.origin,
    organizationId: root.organizationId,
    organizationName: FIXTURE_ORGANIZATION_NAME,
    keys,
  };
}

function parseFileMetadata(value: unknown): CredentialFileMetadata {
  const root = record(value);
  if (
    !exactKeys(root, [
      "name",
      "path",
      "keyId",
      "organizationId",
      "scopes",
      "createdAt",
      "expiresAt",
    ])
  ) {
    throw new IntegrationCredentialError("credential metadata key entry has unexpected members");
  }
  if (
    typeof root.name !== "string" ||
    typeof root.path !== "string" ||
    !boundedSegment(root.keyId) ||
    !boundedSegment(root.organizationId) ||
    !Array.isArray(root.scopes) ||
    typeof root.createdAt !== "string" ||
    typeof root.expiresAt !== "string"
  ) {
    throw new IntegrationCredentialError("credential metadata key entry is malformed");
  }
  const scopes = root.scopes;
  if (!scopes.every((scope) => scope === "resources:write" || scope === "resources:read")) {
    throw new IntegrationCredentialError("credential metadata contains an unsupported scope");
  }
  return {
    name: root.name,
    path: root.path,
    keyId: root.keyId,
    organizationId: root.organizationId,
    scopes: scopes as KeyScope[],
    createdAt: root.createdAt,
    expiresAt: root.expiresAt,
  };
}

function assertMetadataPaths(metadata: CredentialMetadataDocument, paths: CredentialPaths): void {
  const expected = [paths.writer, paths.reader];
  for (let index = 0; index < metadata.keys.length; index += 1) {
    if (metadata.keys[index]?.path !== expected[index]) {
      throw new IntegrationCredentialError("credential metadata path is not an exact owned path");
    }
  }
}

function exactOrganizations(body: unknown): FixtureOrganization[] {
  const values = record(body).organizations;
  if (!Array.isArray(values))
    throw new IntegrationCredentialError("organization list response is malformed");
  return values.map((value) => {
    const organization = record(value);
    if (!boundedSegment(organization.id) || typeof organization.name !== "string") {
      throw new IntegrationCredentialError("organization list entry is malformed");
    }
    return { id: organization.id, name: organization.name };
  });
}

function exactOrganization(body: unknown): FixtureOrganization {
  const organization = record(body).organization;
  const value = record(organization);
  if (!boundedSegment(value.id) || typeof value.name !== "string") {
    throw new IntegrationCredentialError("organization response is malformed");
  }
  return { id: value.id, name: value.name };
}

function exactNamedKeys(keys: readonly ApiKeyMetadata[]): ApiKeyMetadata[] {
  const names = new Set([WRITER_KEY_NAME, READER_KEY_NAME]);
  return keys.filter((key) => names.has(key.name));
}

function parseApiKeyMetadata(value: unknown): ApiKeyMetadata {
  const key = record(value);
  if (
    !boundedSegment(key.id) ||
    !boundedSegment(key.organizationId) ||
    typeof key.name !== "string" ||
    !Array.isArray(key.scopes) ||
    typeof key.createdAt !== "string" ||
    typeof key.expiresAt !== "string"
  ) {
    throw new IntegrationCredentialError("API-key metadata is malformed");
  }
  if (!key.scopes.every(isApiKeyScope)) {
    throw new IntegrationCredentialError("API-key metadata contains an unsupported scope");
  }
  return {
    id: key.id,
    organizationId: key.organizationId,
    name: key.name,
    scopes: key.scopes as KeyScope[],
    createdAt: key.createdAt,
    expiresAt: key.expiresAt,
  };
}

function sameScopes(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((scope, index) => scope === right[index]);
}

function boundedSegment(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 128 &&
    value.trim() === value &&
    !value.includes("/") &&
    !value.includes("%")
  );
}

function isApiKeyScope(value: unknown): value is ApiKeyScope {
  return typeof value === "string" && (API_KEY_SCOPES as readonly string[]).includes(value);
}

function fileMetadata(path: string, key: CreatedKey): CredentialFileMetadata {
  return {
    name: key.name,
    path,
    keyId: key.id,
    organizationId: key.organizationId,
    scopes: key.scopes,
    createdAt: key.createdAt,
    expiresAt: key.expiresAt,
  };
}

function localFileStatus(file: {
  readonly name: string;
  readonly keyId: string;
  readonly path: string;
}): CredentialStatus["files"][number] {
  try {
    const stat = lstatSync(file.path);
    return { ...file, exists: true, mode: stat.mode & 0o777, symlink: stat.isSymbolicLink() };
  } catch {
    return { ...file, exists: false, mode: null, symlink: false };
  }
}

function requiredEnvironment(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name];
  if (!value || value.trim() !== value) throw new IntegrationCredentialError(`${name} is required`);
  return value;
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

function bearer(secret: string): Record<string, string> {
  return { authorization: `Bearer ${secret}` };
}

function requiredString(body: unknown, fields: readonly string[]): string {
  const value = record(body);
  for (const field of fields) {
    if (
      typeof value[field] !== "string" ||
      value[field].length === 0 ||
      value[field].length > 16_384
    ) {
      throw new IntegrationCredentialError(`HTTP response omitted required field ${field}`);
    }
  }
  return value[fields[0] as string] as string;
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new IntegrationCredentialError("HTTP response shape is malformed");
  }
  return value as Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  return JSON.stringify(keys) === JSON.stringify([...expected].sort());
}

function redactSecrets(message: string): string {
  return message
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/giu, "Bearer [REDACTED]")
    .replace(/(sessionToken|secret|assertion|token|d)\s*[=:]\s*[^,\s}]+/giu, "$1=[REDACTED]");
}

function safeError(error: unknown): IntegrationCredentialError {
  if (error instanceof IntegrationCredentialError) return error;
  return new IntegrationCredentialError("integration credential operation failed");
}

interface FixtureOrganization {
  readonly id: string;
  readonly name: string;
}

interface ApiKeyMetadata {
  readonly id: string;
  readonly organizationId: string;
  readonly name: string;
  readonly scopes: readonly KeyScope[];
  readonly createdAt: string;
  readonly expiresAt: string;
}

type CreatedKeyRef = ApiKeyMetadata;

interface CreatedKey extends CreatedKeyRef {
  readonly secret: string;
}

interface PendingCreate {
  readonly name: string;
  readonly knownKeyIds: Set<string>;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await cli().catch((error: unknown) => {
    const safe = safeError(error);
    process.stderr.write(`${safe.message}\n`);
    process.exitCode = 1;
  });
}
