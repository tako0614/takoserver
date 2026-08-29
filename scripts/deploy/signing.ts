import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CloudflareState } from "./cloudflare-state.ts";
import { RemoteD1, sqlLiteral } from "./d1.ts";
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
import { writeWorkerConfig } from "./realized-config.ts";
import type { DeployTarget } from "./target.ts";
import { prepareWorkerArtifact } from "./worker-artifact.ts";
import { inspectLiveWorkerVersion, type WorkerState } from "./worker-live.ts";

const PUBLIC_KEYS = ["crv", "kty", "x"] as const;
const PRIVATE_KEYS = ["crv", "d", "ext", "key_ops", "kty", "x"] as const;
const BASE64URL_32 = /^[A-Za-z0-9_-]{43}$/u;

export interface SigningPublicKeyRow {
  readonly keyId: string;
  readonly publicJwk: string;
  readonly createdAtEpochSeconds: number;
  readonly revokedAtEpochSeconds: number | null;
}

export interface SigningDatabase {
  readKey(keyId: string, phase: DeployPhase): Promise<SigningPublicKeyRow | null>;
  insertPublicKey(keyId: string, publicJwk: string): Promise<void>;
}

export type SigningProcess = (
  command: readonly string[],
  options?: { readonly env?: Readonly<Record<string, string>>; readonly input?: string },
) => Promise<CommandResult>;

export interface SigningInvocation {
  readonly surface:
    | "takoserver-signing-key-register"
    | "takoserver-signing-repair"
    | "takoserver-signing-rotation";
  readonly action: "status" | "apply";
  readonly environment: DeployEnvironment;
  readonly commit: string;
}

export interface SigningOptions {
  readonly run?: SigningProcess;
  readonly database?: SigningDatabase;
  readonly state?: WorkerState;
  readonly publicJwkPath?: string;
  readonly privateJwkPath?: string;
  readonly nextPrivateJwkPath?: string;
  readonly review?: string;
  readonly outputDirectory?: string;
  readonly cloudflareEnvironment?: Readonly<Record<string, string>>;
}

interface PrivateKeyInput {
  readonly raw: string;
  readonly jwk: JsonWebKey & { readonly x: string; readonly d: string };
}

/** Three disjoint operations: public registration, exact repair, explicit rotation. */
export async function runSigning(
  invocation: SigningInvocation,
  target: DeployTarget,
  options: SigningOptions = {},
): Promise<Record<string, unknown>> {
  if (target.environment !== invocation.environment) {
    throw preflightError("signing invocation and target environments differ");
  }
  const run = options.run ?? runCommand;
  const environment =
    options.cloudflareEnvironment ??
    (options.database !== undefined &&
    (invocation.surface === "takoserver-signing-key-register" || options.state !== undefined) &&
    invocation.action === "status"
      ? {}
      : cloudflareChildEnvironment());
  const temporary = options.outputDirectory === undefined;
  const root = options.outputDirectory ?? mkdtempSync(join(tmpdir(), "takoserver-signing-"));
  mkdirSync(root, { recursive: true, mode: 0o700 });
  try {
    const configPath = writeWorkerConfig(target, {
      path: join(root, "inspect-wrangler.jsonc"),
      main: resolve(REPOSITORY, "src/entry-cloudflare-worker.ts"),
      commit: invocation.commit,
      signingKeyId: target.signing.currentKeyId,
    });
    const database = options.database ?? createRemoteSigningDatabase(configPath, environment, run);
    if (invocation.surface === "takoserver-signing-key-register") {
      return await registerPublicKey(invocation, target, database, run, options);
    }

    const state =
      options.state ??
      new CloudflareState({ accountId: target.accountId, token: exactToken(environment) });
    if (invocation.surface === "takoserver-signing-repair") {
      return await repairSigningSecret(
        invocation,
        target,
        database,
        state,
        configPath,
        environment,
        run,
        options,
      );
    }
    return await rotateSigningKey(
      invocation,
      target,
      database,
      state,
      environment,
      run,
      root,
      options,
    );
  } finally {
    if (temporary) rmSync(root, { recursive: true, force: true });
  }
}

async function registerPublicKey(
  invocation: SigningInvocation,
  target: DeployTarget,
  database: SigningDatabase,
  run: SigningProcess,
  options: SigningOptions,
): Promise<Record<string, unknown>> {
  const keyId = target.signing.nextKeyId ?? target.signing.currentKeyId;
  const existing = await database.readKey(keyId, "preflight");
  if (invocation.action === "status") {
    return {
      kind: "takoserver.signing-key-register-status@v2",
      surface: invocation.surface,
      environment: invocation.environment,
      selectedCommit: invocation.commit,
      keyId,
      registered: existing !== null,
      active: existing?.revokedAtEpochSeconds === null,
      publicJwkDigest: existing ? sha256(existing.publicJwk) : null,
      noOverwrite: true,
    };
  }
  if (existing !== null) {
    throw preflightError(
      `signing key ${keyId} already exists; published-identity no-overwrite forbids another apply`,
    );
  }
  const source = await qualifySource({
    environment: invocation.environment === "integration" ? "integration" : "production",
    commit: invocation.commit,
    run,
  });
  const reviewer = exactReviewer(
    options.review ?? requireEnvironment("TAKOSERVER_INDEPENDENT_REVIEW"),
  );
  const publicInput = readPublicJwk(
    options.publicJwkPath ?? requireEnvironment("TAKOSERVER_SIGNING_PUBLIC_JWK_PATH"),
  );
  // Race-safe absence recheck immediately before the append-only INSERT.
  if ((await database.readKey(keyId, "preflight")) !== null) {
    throw preflightError(
      `signing key ${keyId} appeared during qualification; no-overwrite refused`,
    );
  }
  await database.insertPublicKey(keyId, publicInput.canonical);
  const inserted = await database.readKey(keyId, "verification");
  if (
    inserted === null ||
    inserted.keyId !== keyId ||
    inserted.publicJwk !== publicInput.canonical ||
    inserted.revokedAtEpochSeconds !== null
  ) {
    throw verificationError("D1 did not return the exact inserted active public signing identity");
  }
  return {
    kind: "takoserver.signing-key-register-apply@v2",
    surface: invocation.surface,
    environment: invocation.environment,
    commit: source.commit,
    remoteRef: source.remoteRef,
    reviewer,
    keyId,
    publicJwkDigest: sha256(publicInput.canonical),
    noOverwrite: true,
    rollback: "forward repair only: register a new key id; never overwrite or delete this identity",
  };
}

async function repairSigningSecret(
  invocation: SigningInvocation,
  target: DeployTarget,
  database: SigningDatabase,
  state: WorkerState,
  configPath: string,
  environment: Readonly<Record<string, string>>,
  run: SigningProcess,
  options: SigningOptions,
): Promise<Record<string, unknown>> {
  const keyId = target.signing.currentKeyId;
  const row = requiredActiveRow(await database.readKey(keyId, "preflight"), keyId);
  const before = await inspectLiveWorkerVersion("preflight", target, state, {
    signingKeyId: keyId,
  });
  if (invocation.action === "status") {
    return {
      kind: "takoserver.signing-repair-status@v2",
      surface: invocation.surface,
      environment: invocation.environment,
      selectedCommit: invocation.commit,
      deployedCommit: before.commit,
      keyId,
      publicJwkDigest: sha256(row.publicJwk),
      versionId: before.history.versionId,
      ready: before.commit === invocation.commit,
    };
  }
  const source = await qualifySource({
    environment: invocation.environment === "integration" ? "integration" : "production",
    commit: invocation.commit,
    run,
  });
  if (before.commit !== source.commit) {
    throw preflightError("signing repair commit must equal the currently served Worker commit");
  }
  const reviewer = exactReviewer(
    options.review ?? requireEnvironment("TAKOSERVER_INDEPENDENT_REVIEW"),
  );
  const privateInput = readPrivateJwk(
    options.privateJwkPath ?? requireEnvironment("TAKOSERVER_SIGNING_PRIVATE_JWK_PATH"),
  );
  await provePrivateMatchesRow(privateInput, row);
  requiredExactRow(await database.readKey(keyId, "preflight"), row, "preflight");
  const mutation = await run(
    wranglerCommand([
      "secret",
      "put",
      "TAKOSERVER_SIGNING_KEY",
      "--name",
      target.workerName,
      "--config",
      configPath,
    ]),
    { env: environment, input: privateInput.raw },
  );
  if (mutation.exitCode !== 0) {
    throw mutationError(
      "signing secret repair acknowledgement is indeterminate; do not retry before --status",
      `${mutation.stdout}${mutation.stderr}`.trim(),
    );
  }
  const after = await inspectLiveWorkerVersion("verification", target, state, {
    signingKeyId: keyId,
  });
  assertSecretOnlyAdvance(before, after);
  requiredExactRow(await database.readKey(keyId, "verification"), row, "verification");
  return {
    kind: "takoserver.signing-repair-apply@v2",
    surface: invocation.surface,
    environment: invocation.environment,
    commit: source.commit,
    reviewer,
    keyId,
    previousVersionId: before.history.versionId,
    versionId: after.history.versionId,
    keyPairProof: { keyId, publicJwkDigest: sha256(row.publicJwk) },
    rollback:
      "reapply the previous exact private JWK through takoserver-signing-repair; secret bytes are not recoverable from Cloudflare",
  };
}

async function rotateSigningKey(
  invocation: SigningInvocation,
  target: DeployTarget,
  database: SigningDatabase,
  state: WorkerState,
  environment: Readonly<Record<string, string>>,
  run: SigningProcess,
  root: string,
  options: SigningOptions,
): Promise<Record<string, unknown>> {
  const currentKeyId = target.signing.currentKeyId;
  const nextKeyId = target.signing.nextKeyId;
  if (!nextKeyId || nextKeyId === currentKeyId) {
    throw preflightError("signing rotation requires explicit different current and next key ids");
  }
  const current = requiredActiveRow(
    await database.readKey(currentKeyId, "preflight"),
    currentKeyId,
  );
  const next = requiredActiveRow(await database.readKey(nextKeyId, "preflight"), nextKeyId);
  const before = await inspectLiveWorkerVersion("preflight", target, state, {
    signingKeyId: currentKeyId,
  });
  if (invocation.action === "status") {
    return {
      kind: "takoserver.signing-rotation-status@v2",
      surface: invocation.surface,
      environment: invocation.environment,
      selectedCommit: invocation.commit,
      deployedCommit: before.commit,
      currentKeyId,
      nextKeyId,
      currentRegistered: true,
      nextRegistered: true,
      ready: before.commit === invocation.commit,
      noOverwrite: true,
    };
  }
  const source = await qualifySource({
    environment: invocation.environment === "integration" ? "integration" : "production",
    commit: invocation.commit,
    run,
  });
  if (before.commit !== source.commit) {
    throw preflightError("signing rotation commit must equal the currently served Worker commit");
  }
  const reviewer = exactReviewer(
    options.review ?? requireEnvironment("TAKOSERVER_INDEPENDENT_REVIEW"),
  );
  const privateInput = readPrivateJwk(
    options.nextPrivateJwkPath ?? requireEnvironment("TAKOSERVER_SIGNING_NEXT_PRIVATE_JWK_PATH"),
  );
  await provePrivateMatchesRow(privateInput, next);
  // Re-read both immutable identities immediately before building; neither is
  // ever inserted, overwritten, revoked, or deleted by rotation.
  requiredExactRow(await database.readKey(currentKeyId, "preflight"), current, "preflight");
  requiredExactRow(await database.readKey(nextKeyId, "preflight"), next, "preflight");
  const prepared = await prepareWorkerArtifact({
    root,
    target,
    commit: source.commit,
    signingKeyId: nextKeyId,
    run,
  });
  if (prepared.bundleDigestHex !== before.bundleDigestHex) {
    throw preflightError(
      "signing rotation refuses to carry different Worker code bytes",
      `served=sha256:${before.bundleDigestHex} built=sha256:${prepared.bundleDigestHex}`,
    );
  }
  const secretsPath = join(prepared.releaseDirectory, "secrets.json");
  writeFileSync(secretsPath, `${JSON.stringify({ TAKOSERVER_SIGNING_KEY: privateInput.raw })}\n`, {
    mode: 0o600,
  });
  const sealed = prepared.seal(["secrets.json"]);
  sealed.assertUnchanged();
  const message = `takoserver-worker:${source.commit}:${prepared.bundleDigestHex}`;
  const upload = await run(
    wranglerCommand([
      "deploy",
      prepared.bundlePath,
      "--no-bundle",
      "--config",
      prepared.configPath,
      "--strict",
      "--message",
      message,
      "--secrets-file",
      secretsPath,
    ]),
    { env: environment },
  );
  if (upload.exitCode !== 0) {
    throw mutationError(
      "signing rotation upload acknowledgement is indeterminate; do not retry before --status",
      `${upload.stdout}${upload.stderr}`.trim(),
    );
  }
  const after = await inspectLiveWorkerVersion("verification", target, state, {
    signingKeyId: nextKeyId,
  });
  if (
    after.history.versionId === before.history.versionId ||
    after.history.previousVersionId !== before.history.versionId ||
    after.commit !== before.commit ||
    after.bundleDigestHex !== before.bundleDigestHex
  ) {
    throw verificationError("signing rotation changed more than the explicit key id and secret");
  }
  requiredExactRow(await database.readKey(currentKeyId, "verification"), current, "verification");
  requiredExactRow(await database.readKey(nextKeyId, "verification"), next, "verification");
  return {
    kind: "takoserver.signing-rotation-apply@v2",
    surface: invocation.surface,
    environment: invocation.environment,
    commit: source.commit,
    reviewer,
    currentKeyId,
    nextKeyId,
    previousVersionId: before.history.versionId,
    versionId: after.history.versionId,
    noOverwrite: true,
    keyPairProof: { keyId: nextKeyId, publicJwkDigest: sha256(next.publicJwk) },
    rollback:
      "run a separately reviewed inverse takoserver-signing-rotation while both public ids remain registered",
  };
}

export function createRemoteSigningDatabase(
  configPath: string,
  environment: Readonly<Record<string, string>>,
  run: SigningProcess,
): SigningDatabase {
  const database = new RemoteD1(configPath, { environment, run });
  return {
    async readKey(keyId, phase) {
      const rows = await database.query(
        phase,
        `D1 public signing key ${keyId}`,
        "SELECT key_id, public_jwk, created_at_epoch_seconds, revoked_at_epoch_seconds " +
          `FROM runtime_grant_keys WHERE key_id = ${sqlLiteral(keyId)} LIMIT 2`,
      );
      if (rows.length === 0) return null;
      if (rows.length !== 1) throw phaseFailure(phase, `D1 has duplicate signing key ${keyId}`);
      const row = rows[0];
      if (
        typeof row?.key_id !== "string" ||
        typeof row.public_jwk !== "string" ||
        !Number.isSafeInteger(row.created_at_epoch_seconds) ||
        (row.revoked_at_epoch_seconds !== null &&
          !Number.isSafeInteger(row.revoked_at_epoch_seconds))
      ) {
        throw phaseFailure(phase, `D1 signing key ${keyId} has an invalid row shape`);
      }
      return {
        keyId: row.key_id,
        publicJwk: row.public_jwk,
        createdAtEpochSeconds: row.created_at_epoch_seconds as number,
        revokedAtEpochSeconds: row.revoked_at_epoch_seconds as number | null,
      };
    },
    async insertPublicKey(keyId, publicJwk) {
      await database.statement(
        "mutation",
        `append-only public signing key ${keyId}`,
        "INSERT INTO runtime_grant_keys " +
          "(key_id, public_jwk, created_at_epoch_seconds, revoked_at_epoch_seconds) VALUES " +
          `(${sqlLiteral(keyId)}, ${sqlLiteral(publicJwk)}, unixepoch(), NULL)`,
      );
    },
  };
}

/** Public half only, for another bounded authority proof in this deploy package. */
export function activePublicJwk(
  row: SigningPublicKeyRow | null,
  keyId: string,
): JsonWebKey & { readonly x: string } {
  return readCanonicalPublicRow(requiredActiveRow(row, keyId));
}

function readPublicJwk(path: string): { readonly canonical: string; readonly jwk: JsonWebKey } {
  const raw = readOwnedRegular(path, "public signing JWK", false);
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw preflightError("public signing JWK is not valid JSON");
  }
  if (!isRecord(value) || !exactKeys(value, PUBLIC_KEYS)) {
    throw preflightError("public signing JWK must be public-only with exact kty/crv/x members");
  }
  if (value.kty !== "OKP" || value.crv !== "Ed25519" || !BASE64URL_32.test(String(value.x))) {
    throw preflightError("public signing JWK must be one exact Ed25519 public key");
  }
  const jwk = { kty: "OKP", crv: "Ed25519", x: value.x as string } satisfies JsonWebKey;
  return { canonical: JSON.stringify(jwk), jwk };
}

function readPrivateJwk(path: string): PrivateKeyInput {
  const raw = readOwnedRegular(path, "private signing JWK", true);
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw preflightError("private signing JWK is not valid JSON");
  }
  if (!isRecord(value) || !exactKeys(value, PRIVATE_KEYS)) {
    throw preflightError("private signing JWK has unexpected or missing members");
  }
  if (
    value.kty !== "OKP" ||
    value.crv !== "Ed25519" ||
    value.ext !== true ||
    !Array.isArray(value.key_ops) ||
    JSON.stringify(value.key_ops) !== JSON.stringify(["sign"]) ||
    !BASE64URL_32.test(String(value.x)) ||
    !BASE64URL_32.test(String(value.d))
  ) {
    throw preflightError("private signing JWK must be one exact Ed25519 signing key");
  }
  return {
    raw,
    jwk: value as unknown as JsonWebKey & { readonly x: string; readonly d: string },
  };
}

async function provePrivateMatchesRow(
  input: PrivateKeyInput,
  row: SigningPublicKeyRow,
): Promise<void> {
  const parsed = readCanonicalPublicRow(row);
  if (input.jwk.x !== parsed.x) {
    throw preflightError(`private signing JWK does not match D1 key ${row.keyId}`);
  }
  try {
    const privateKey = await crypto.subtle.importKey("jwk", input.jwk, { name: "Ed25519" }, false, [
      "sign",
    ]);
    const publicKey = await crypto.subtle.importKey("jwk", parsed, { name: "Ed25519" }, false, [
      "verify",
    ]);
    const message = new TextEncoder().encode("takoserver.deploy.key-pair-proof@v1");
    const signature = await crypto.subtle.sign("Ed25519", privateKey, message);
    if (!(await crypto.subtle.verify("Ed25519", publicKey, signature, message))) throw new Error();
  } catch {
    throw preflightError(`private signing JWK cannot prove D1 key ${row.keyId}`);
  }
}

function readCanonicalPublicRow(row: SigningPublicKeyRow): JsonWebKey & { readonly x: string } {
  let value: unknown;
  try {
    value = JSON.parse(row.publicJwk);
  } catch {
    throw preflightError(`D1 signing key ${row.keyId} is not valid JSON`);
  }
  if (
    !isRecord(value) ||
    !exactKeys(value, PUBLIC_KEYS) ||
    value.kty !== "OKP" ||
    value.crv !== "Ed25519" ||
    !BASE64URL_32.test(String(value.x)) ||
    JSON.stringify(value) !== row.publicJwk
  ) {
    throw preflightError(`D1 signing key ${row.keyId} is not one canonical Ed25519 public JWK`);
  }
  return value as unknown as JsonWebKey & { readonly x: string };
}

function requiredActiveRow(row: SigningPublicKeyRow | null, keyId: string): SigningPublicKeyRow {
  if (!row || row.keyId !== keyId || row.revokedAtEpochSeconds !== null) {
    throw preflightError(`signing key ${keyId} is not exactly one active pre-registered D1 row`);
  }
  readCanonicalPublicRow(row);
  return row;
}

function requiredExactRow(
  actual: SigningPublicKeyRow | null,
  expected: SigningPublicKeyRow,
  phase: DeployPhase,
): void {
  if (
    actual?.keyId !== expected.keyId ||
    actual.publicJwk !== expected.publicJwk ||
    actual.createdAtEpochSeconds !== expected.createdAtEpochSeconds ||
    actual.revokedAtEpochSeconds !== expected.revokedAtEpochSeconds
  ) {
    throw phaseFailure(phase, `D1 signing identity ${expected.keyId} changed during operation`);
  }
}

function assertSecretOnlyAdvance(
  before: Awaited<ReturnType<typeof inspectLiveWorkerVersion>>,
  after: Awaited<ReturnType<typeof inspectLiveWorkerVersion>>,
): void {
  if (
    after.history.versionId === before.history.versionId ||
    after.history.previousVersionId !== before.history.versionId ||
    after.commit !== before.commit ||
    after.bundleDigestHex !== before.bundleDigestHex
  ) {
    throw verificationError("signing repair changed more than the exact existing secret");
  }
}

function readOwnedRegular(path: string, label: string, secret: boolean): string {
  let status: ReturnType<typeof lstatSync>;
  let raw: string;
  try {
    status = lstatSync(path);
    raw = readFileSync(path, "utf8");
  } catch {
    throw preflightError(`${label} is unavailable`);
  }
  if (
    !status.isFile() ||
    status.isSymbolicLink() ||
    status.nlink !== 1 ||
    (typeof process.getuid === "function" && status.uid !== process.getuid()) ||
    (secret ? (status.mode & 0o777) !== 0o600 : (status.mode & 0o022) !== 0) ||
    raw.length === 0 ||
    raw.length > 16_384
  ) {
    throw preflightError(
      secret
        ? `${label} must be an owned 0600 regular file`
        : `${label} must be an owned non-writable-by-others regular file`,
    );
  }
  return raw;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
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

function phaseFailure(phase: DeployPhase, message: string) {
  return phase === "preflight"
    ? preflightError(message)
    : phase === "mutation"
      ? mutationError(message)
      : verificationError(message);
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
