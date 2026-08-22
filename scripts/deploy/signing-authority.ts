import { lstatSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { RemoteD1, sqlLiteral } from "./d1.ts";
import { DeployError, type DeployPhase, mutationError, preflightError } from "./errors.ts";
import { REPOSITORY, runChecked, wranglerCommand } from "./process.ts";
import type { DeployTarget } from "./target.ts";

const PROOF_INPUT = new TextEncoder().encode("takoserver.deploy.signing-authority@v1");

export interface SigningAuthority {
  readonly keyId: string;
  readonly privatePath: string;
  readonly privateDigest: string;
  readonly publicJwk: JsonWebKey;
}

/**
 * Binds the operator-held private half to the one active public half in D1.
 * No secret bytes leave this module or enter a diagnostic.
 */
export async function inspectSigningAuthority(
  phase: DeployPhase,
  configPath: string,
  target: DeployTarget,
): Promise<SigningAuthority> {
  const path = resolve(REPOSITORY, ".deploy/private", `${target.grantKeyId}.jwk`);
  const raw = readPrivateKey(phase, path);
  const privateJwk = parsePrivateJwk(phase, raw);
  const rows = await new RemoteD1(configPath).query(
    phase,
    "active signing public key readback",
    "SELECT public_jwk FROM runtime_grant_keys " +
      `WHERE key_id = ${sqlLiteral(target.grantKeyId)} ` +
      "AND revoked_at_epoch_seconds IS NULL LIMIT 2",
  );
  if (rows.length !== 1 || typeof rows[0]?.public_jwk !== "string") {
    throw phaseError(phase, `signing key ${target.grantKeyId} is not exactly one active D1 key`);
  }
  const publicJwk = parsePublicJwk(phase, rows[0].public_jwk);
  if (privateJwk.x !== publicJwk.x) {
    throw phaseError(
      phase,
      `private signing key ${target.grantKeyId} does not match its active D1 public key`,
    );
  }
  await proveKeyPair(phase, privateJwk, publicJwk);
  return {
    keyId: target.grantKeyId,
    privatePath: path,
    privateDigest: sha256(raw),
    publicJwk,
  };
}

/** Writes the exact reviewed local private JWK to the Worker secret via stdin. */
export async function synchronizeSigningSecret(
  configPath: string,
  expected: SigningAuthority,
): Promise<void> {
  const raw = readPrivateKey("mutation", expected.privatePath);
  if (sha256(raw) !== expected.privateDigest) {
    throw mutationError("the signing private key changed after preflight");
  }
  await runChecked(
    "mutation",
    "Worker signing key synchronization",
    wranglerCommand(["secret", "put", "TAKOSERVER_SIGNING_KEY", "--config", configPath]),
    { input: raw },
  );
}

/**
 * Asks the already-serving private sponsorship seam to mint one bounded token,
 * then checks its signature locally against the exact D1 key. The token and
 * opaque tenant never enter output or evidence.
 */
export async function liveSigningKeyMatches(
  phase: DeployPhase,
  configPath: string,
  target: DeployTarget,
  authority: SigningAuthority,
): Promise<boolean | null> {
  if (!target.hostedSponsorship) return null;
  const serviceToken = process.env.TAKOSERVER_HOSTED_SPONSORSHIP_TOKEN;
  if (!serviceToken || serviceToken.trim() !== serviceToken) {
    throw phaseError(
      phase,
      "TAKOSERVER_HOSTED_SPONSORSHIP_TOKEN is required for the live signing proof",
    );
  }
  const tenants = await new RemoteD1(configPath).column(
    phase,
    "sponsorship signing-proof tenant readback",
    "SELECT tenant_ref FROM sponsorship_tenants ORDER BY tenant_ref LIMIT 1",
    "tenant_ref",
  );
  const tenantRef = tenants[0];
  if (!tenantRef) {
    throw phaseError(phase, "hosted sponsorship is enabled but has no tenant for signing proof");
  }
  const response = await fetch(
    `${target.publicOrigin}/v1/sponsorship/tenants/${encodeURIComponent(tenantRef)}/takoform-run-credentials`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${serviceToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        runRef: "deploy-signing-proof",
        spaceRef: "deploy-signing-proof",
        expiresInSeconds: 60,
      }),
      signal: AbortSignal.timeout(15_000),
    },
  ).catch(() => null);
  if (response?.status !== 201) {
    throw phaseError(phase, "the live signing proof endpoint did not issue a credential");
  }
  const body = (await response.json().catch(() => null)) as {
    readonly takoformRunCredential?: { readonly token?: unknown };
  } | null;
  const token = body?.takoformRunCredential?.token;
  if (typeof token !== "string") {
    throw phaseError(phase, "the live signing proof returned an invalid credential shape");
  }
  return await verifyJwtSignature(token, authority.keyId, authority.publicJwk);
}

export async function verifyJwtSignature(
  token: string,
  expectedKeyId: string,
  publicJwk: JsonWebKey,
): Promise<boolean> {
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  const [headerPart, payloadPart, signaturePart] = parts;
  if (!headerPart || !payloadPart || !signaturePart) return false;
  let header: unknown;
  try {
    header = JSON.parse(new TextDecoder().decode(base64Url(headerPart)));
  } catch {
    return false;
  }
  if (
    !header ||
    typeof header !== "object" ||
    (header as Record<string, unknown>).kid !== expectedKeyId ||
    (header as Record<string, unknown>).alg !== "EdDSA"
  ) {
    return false;
  }
  const key = await crypto.subtle
    .importKey("jwk", publicJwk, { name: "Ed25519" }, false, ["verify"])
    .catch(() => null);
  if (!key) return false;
  return await crypto.subtle
    .verify(
      "Ed25519",
      key,
      base64Url(signaturePart) as unknown as BufferSource,
      new TextEncoder().encode(`${headerPart}.${payloadPart}`),
    )
    .catch(() => false);
}

function readPrivateKey(phase: DeployPhase, path: string): string {
  let status: ReturnType<typeof lstatSync>;
  let raw: string;
  try {
    status = lstatSync(path);
    raw = readFileSync(path, "utf8");
  } catch {
    throw phaseError(phase, `signing private key is unavailable at ${path}`);
  }
  if (
    !status.isFile() ||
    status.isSymbolicLink() ||
    status.nlink !== 1 ||
    (status.mode & 0o777) !== 0o600 ||
    (typeof process.getuid === "function" && status.uid !== process.getuid())
  ) {
    throw phaseError(phase, `signing private key at ${path} is not an owned 0600 regular file`);
  }
  return raw;
}

function parsePrivateJwk(phase: DeployPhase, raw: string): JsonWebKey & { x: string; d: string } {
  let value: JsonWebKey;
  try {
    value = JSON.parse(raw) as JsonWebKey;
  } catch {
    throw phaseError(phase, "the signing private key is not valid JSON");
  }
  if (
    value.kty !== "OKP" ||
    value.crv !== "Ed25519" ||
    typeof value.x !== "string" ||
    typeof value.d !== "string"
  ) {
    throw phaseError(phase, "the signing private key is not an Ed25519 private JWK");
  }
  return value as JsonWebKey & { x: string; d: string };
}

function parsePublicJwk(phase: DeployPhase, raw: string): JsonWebKey & { x: string } {
  let value: JsonWebKey;
  try {
    value = JSON.parse(raw) as JsonWebKey;
  } catch {
    throw phaseError(phase, "the active D1 signing key is not valid JSON");
  }
  if (value.kty !== "OKP" || value.crv !== "Ed25519" || typeof value.x !== "string") {
    throw phaseError(phase, "the active D1 signing key is not an Ed25519 public JWK");
  }
  return value as JsonWebKey & { x: string };
}

async function proveKeyPair(
  phase: DeployPhase,
  privateJwk: JsonWebKey,
  publicJwk: JsonWebKey,
): Promise<void> {
  try {
    const privateKey = await crypto.subtle.importKey(
      "jwk",
      privateJwk,
      { name: "Ed25519" },
      false,
      ["sign"],
    );
    const publicKey = await crypto.subtle.importKey("jwk", publicJwk, { name: "Ed25519" }, false, [
      "verify",
    ]);
    const signature = await crypto.subtle.sign("Ed25519", privateKey, PROOF_INPUT);
    if (!(await crypto.subtle.verify("Ed25519", publicKey, signature, PROOF_INPUT))) {
      throw new Error();
    }
  } catch {
    throw phaseError(phase, "the signing private key cannot prove the active D1 public key");
  }
}

function base64Url(value: string): Uint8Array {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

function sha256(value: string): string {
  return `sha256:${new Bun.CryptoHasher("sha256").update(value).digest("hex")}`;
}

function phaseError(phase: DeployPhase, message: string): DeployError {
  return phase === "preflight"
    ? preflightError(message)
    : phase === "mutation"
      ? mutationError(message)
      : new DeployError("verification", message);
}
