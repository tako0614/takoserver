import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import {
  isOperatorProvider,
  OPERATOR_PROVIDERS,
  type OperatorProvider,
} from "../../src/operator-credentials.ts";
import { signOperatorAssertion } from "../../src/operator-key.ts";
import {
  DeployError,
  type DeployPhase,
  mutationError,
  preflightError,
  verificationError,
} from "./errors.ts";

export const OPERATOR_PRIVATE_JWK_ENV = "TAKOSERVER_OPERATOR_PRIVATE_JWK_PATH";
export const OPERATOR_IDENTITY_ENV = "TAKOSERVER_ORG_API_KEY_OPERATOR_IDENTITY_PATH";

export interface PrivateKeyInput {
  readonly jwk: JsonWebKey & { readonly x: string; readonly d: string };
}

export interface OperatorSignInIdentity {
  readonly provider: OperatorProvider;
  readonly subject: string;
  readonly email: string;
  readonly displayName: string;
}

export interface OperatorAuthoritySession {
  /** Same-origin request carrying the short-lived proof session. */
  request(path: string, init?: RequestInit): Promise<Response>;
}

export interface OperatorSessionProof {
  readonly sessionStatus: 200;
  readonly meStatus: 200;
  readonly organizationId: string;
  readonly organizationRole: "owner";
  readonly revokeStatus: number | "transport-error";
  readonly replayStatus: 401;
  readonly assertionRedacted: true;
  readonly sessionRedacted: true;
}

const PRIVATE_JWK_KEYS = ["crv", "d", "ext", "key_ops", "kty", "x"] as const;
const IDENTITY_KIND = "takoserver.operator-sign-in-identity@v1";
const IDENTITY_KEYS = ["kind", "provider", "subject", "email", "displayName"] as const;
const PRINCIPAL_KEYS = ["displayName", "email", "id", "provider", "providerSubject"] as const;
const ORGANIZATION_KEYS = ["createdAt", "id", "name", "ownerPrincipalId"] as const;
const BASE64URL_32 = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/u;
const MAX_INPUT_BYTES = 16_384;
const PROOF_LIFETIME_SECONDS = 60;

/** Reads one operator-owned, non-linkable, exact private signing key. */
export function readPrivateJwk(path: string): PrivateKeyInput {
  if (!isAbsolute(path)) {
    throw preflightError("operator private JWK input must be one absolute path");
  }
  const value = readOwnedJson(path, "operator private JWK");
  if (
    !isRecord(value) ||
    !exactKeys(value, PRIVATE_JWK_KEYS) ||
    value.kty !== "OKP" ||
    value.crv !== "Ed25519" ||
    value.ext !== true ||
    !Array.isArray(value.key_ops) ||
    JSON.stringify(value.key_ops) !== JSON.stringify(["sign"]) ||
    typeof value.x !== "string" ||
    typeof value.d !== "string" ||
    !BASE64URL_32.test(value.x) ||
    !BASE64URL_32.test(value.d)
  ) {
    throw preflightError("operator private JWK must be one exact Ed25519 signing key");
  }
  return {
    jwk: value as unknown as JsonWebKey & { readonly x: string; readonly d: string },
  };
}

/** Cryptographically proves that the private input is the target's public key. */
export async function provePrivateMatchesPublic(
  input: PrivateKeyInput,
  publicJwk: { readonly kty: "OKP"; readonly crv: "Ed25519"; readonly x: string },
): Promise<void> {
  if (input.jwk.x !== publicJwk.x) {
    throw preflightError("operator private JWK does not match target public JWK");
  }
  try {
    const privateKey = await crypto.subtle.importKey("jwk", input.jwk, { name: "Ed25519" }, false, [
      "sign",
    ]);
    const publicKey = await crypto.subtle.importKey("jwk", publicJwk, { name: "Ed25519" }, false, [
      "verify",
    ]);
    const message = new TextEncoder().encode("takoserver.deploy.operator-authority-key-proof@v1");
    const signature = await crypto.subtle.sign("Ed25519", privateKey, message);
    if (!(await crypto.subtle.verify("Ed25519", publicKey, signature, message))) {
      throw new Error("pair proof failed");
    }
  } catch {
    throw preflightError("operator private JWK does not match target public JWK");
  }
}

/** Reads the real Host principal the operator key is allowed to assert. */
export function readOperatorSignInIdentity(path: string): OperatorSignInIdentity {
  if (!isAbsolute(path)) {
    throw preflightError(`${OPERATOR_IDENTITY_ENV} must be one absolute path`);
  }
  const value = readOwnedJson(path, "operator sign-in identity");
  if (
    !isRecord(value) ||
    !exactKeys(value, IDENTITY_KEYS) ||
    value.kind !== IDENTITY_KIND ||
    typeof value.provider !== "string" ||
    !boundedText(value.subject) ||
    !boundedText(value.email) ||
    !boundedText(value.displayName)
  ) {
    throw preflightError(
      `operator sign-in identity must be exactly ${IDENTITY_KIND} with provider, subject, email and displayName`,
    );
  }
  if (!isOperatorProvider(value.provider)) {
    throw preflightError(
      `operator sign-in identity names provider ${value.provider}, which no operator assertion can vouch for; ` +
        `the organization's owner principal must sign in under one of ${OPERATOR_PROVIDERS.join(", ")}`,
    );
  }
  return {
    provider: value.provider,
    subject: value.subject as string,
    email: value.email as string,
    displayName: value.displayName as string,
  };
}

/**
 * Opens one sixty-second operator session, proves exact organization ownership,
 * lets the caller use it, then revokes it and proves replay rejection.
 *
 * Assertion, bearer, input paths and response bodies remain inside this module.
 */
export async function withOperatorOwnerSession<T>(
  input: {
    readonly origin: string;
    readonly organizationId: string;
    readonly privateInput: PrivateKeyInput;
    readonly identity: OperatorSignInIdentity;
    readonly fetcher: (input: string, init?: RequestInit) => Promise<Response>;
    readonly now?: () => Date;
    readonly phase: DeployPhase;
    readonly cleanupPhase?: DeployPhase;
  },
  use: (session: OperatorAuthoritySession) => Promise<T>,
): Promise<{ readonly value: T; readonly proof: OperatorSessionProof }> {
  const nowSeconds = Math.floor((input.now?.() ?? new Date()).getTime() / 1_000);
  if (!Number.isSafeInteger(nowSeconds)) {
    throw phaseError(input.phase, "operator authority proof clock is invalid");
  }
  let assertion: string;
  try {
    assertion = await signOperatorAssertion({
      privateJwk: JSON.stringify(input.privateInput.jwk),
      claims: {
        purpose: "sign-in",
        aud: input.origin,
        provider: input.identity.provider,
        subject: input.identity.subject,
        email: input.identity.email,
        displayName: input.identity.displayName,
      },
      nowSeconds,
      lifetimeSeconds: PROOF_LIFETIME_SECONDS,
    });
  } catch {
    throw phaseError(
      input.phase,
      "operator authority assertion signing failed; private key redacted",
    );
  }

  await proveExistingOwner({
    origin: input.origin,
    organizationId: input.organizationId,
    assertion,
    identity: input.identity,
    fetcher: input.fetcher,
    phase: input.phase,
  });

  let response: Response;
  try {
    response = await input.fetcher(`${input.origin}/v1/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json", "cache-control": "no-store" },
      body: JSON.stringify({
        provider: input.identity.provider,
        method: "operator-assertion",
        assertion,
        sessionTtlSeconds: PROOF_LIFETIME_SECONDS,
      }),
      redirect: "error",
    });
  } catch {
    throw phaseError(
      input.phase,
      "operator authority session transport failed; credentials redacted",
    );
  }
  const body = (await response.json().catch(() => null)) as unknown;
  if (response.status === 400 && errorCode(body) === "invalid") {
    throw phaseError(
      input.phase,
      `Host verifies no operator assertion for provider ${input.identity.provider}`,
    );
  }
  const sessionToken = isRecord(body) ? body.sessionToken : undefined;
  if (
    response.status !== 200 ||
    !isRecord(body) ||
    typeof sessionToken !== "string" ||
    sessionToken.length < 1 ||
    sessionToken.length > MAX_INPUT_BYTES
  ) {
    throw phaseError(
      input.phase,
      "operator authority sign-in returned no usable redacted session",
      `status=${response.status}`,
    );
  }

  const session = sessionClient(input.origin, sessionToken, input.fetcher);
  let primaryFailure: unknown;
  let value: T | undefined;
  let ownershipProved = false;
  try {
    if (!exactKeys(body, ["principal", "sessionToken"])) {
      throw phaseError(
        input.phase,
        "operator authority sign-in returned a malformed redacted response",
        `status=${response.status}`,
      );
    }
    const signedInPrincipal = exactPrincipal(body.principal, input.identity, input.phase);
    let me: Response;
    try {
      me = await session.request("/v1/me");
    } catch {
      throw phaseError(
        input.phase,
        "operator authority /v1/me transport failed; credentials redacted",
      );
    }
    const meBody = (await me.json().catch(() => null)) as unknown;
    if (
      me.status !== 200 ||
      !isRecord(meBody) ||
      !exactKeys(meBody, ["organizations", "principal"]) ||
      !Array.isArray(meBody.organizations)
    ) {
      throw phaseError(
        input.phase,
        "operator authority /v1/me returned an invalid redacted response",
        `status=${me.status}`,
      );
    }
    const mePrincipal = exactPrincipal(meBody.principal, input.identity, input.phase);
    if (canonicalJson(mePrincipal) !== canonicalJson(signedInPrincipal)) {
      throw phaseError(input.phase, "operator authority principal changed during owner proof");
    }
    const organizations = exactOrganizations(meBody.organizations, input.phase);
    const selected = organizations.find(({ id }) => id === input.organizationId);
    if (selected?.ownerPrincipalId !== signedInPrincipal.id) {
      throw phaseError(
        input.phase,
        `the operator sign-in identity does not own ${input.organizationId}`,
      );
    }
    ownershipProved = true;
    value = await use(session);
  } catch (error) {
    primaryFailure = error;
  }

  let closure: Awaited<ReturnType<typeof closeSession>> | undefined;
  let cleanupFailure: unknown;
  try {
    closure = await closeSession(
      input.origin,
      sessionToken,
      input.fetcher,
      input.cleanupPhase ?? input.phase,
    );
  } catch (error) {
    cleanupFailure = error;
  }
  if (primaryFailure !== undefined && cleanupFailure !== undefined) {
    throw combinedAuthorityFailure(primaryFailure, cleanupFailure, input.phase);
  }
  if (cleanupFailure !== undefined) throw cleanupFailure;
  if (primaryFailure !== undefined) throw primaryFailure;
  if (!ownershipProved || closure === undefined) {
    throw phaseError(input.phase, "operator authority owner proof did not complete");
  }
  return {
    value: value as T,
    proof: {
      sessionStatus: 200,
      meStatus: 200,
      organizationId: input.organizationId,
      organizationRole: "owner",
      ...closure,
      assertionRedacted: true,
      sessionRedacted: true,
    },
  };
}

async function proveExistingOwner(input: {
  readonly origin: string;
  readonly organizationId: string;
  readonly assertion: string;
  readonly identity: OperatorSignInIdentity;
  readonly fetcher: (input: string, init?: RequestInit) => Promise<Response>;
  readonly phase: DeployPhase;
}): Promise<void> {
  let response: Response;
  try {
    response = await input.fetcher(`${input.origin}/v1/operator-owner-proof`, {
      method: "POST",
      headers: { "content-type": "application/json", "cache-control": "no-store" },
      body: JSON.stringify({
        provider: input.identity.provider,
        method: "operator-assertion",
        assertion: input.assertion,
        organizationId: input.organizationId,
      }),
      redirect: "error",
    });
  } catch {
    throw phaseError(
      input.phase,
      "operator authority existing-owner proof transport failed; credentials redacted",
    );
  }
  const body = (await response.json().catch(() => null)) as unknown;
  if (response.status === 400 && errorCode(body) === "invalid") {
    throw phaseError(
      input.phase,
      `Host verifies no operator assertion for provider ${input.identity.provider}`,
    );
  }
  if (
    response.status !== 200 ||
    !isRecord(body) ||
    !exactKeys(body, ["principal", "organization"])
  ) {
    throw phaseError(
      input.phase,
      `operator assertion does not prove existing exact ownership; the operator sign-in identity does not own ${input.organizationId}`,
      `status=${response.status}`,
    );
  }
  const principal = exactPrincipal(body.principal, input.identity, input.phase);
  const organization = exactOrganization(body.organization, input.phase);
  if (organization.id !== input.organizationId || organization.ownerPrincipalId !== principal.id) {
    throw phaseError(
      input.phase,
      `operator assertion does not prove existing exact ownership; the operator sign-in identity does not own ${input.organizationId}`,
    );
  }
}

function sessionClient(
  origin: string,
  sessionToken: string,
  fetcher: (input: string, init?: RequestInit) => Promise<Response>,
): OperatorAuthoritySession {
  return {
    async request(path, init = {}) {
      if (!path.startsWith("/") || path.startsWith("//")) {
        throw preflightError("operator authority session request must use one same-origin path");
      }
      const headers = new Headers(init.headers);
      headers.set("authorization", `Bearer ${sessionToken}`);
      headers.set("cache-control", "no-store");
      return await fetcher(`${origin}${path}`, { ...init, headers, redirect: "error" });
    },
  };
}

async function closeSession(
  origin: string,
  sessionToken: string,
  fetcher: (input: string, init?: RequestInit) => Promise<Response>,
  phase: DeployPhase,
): Promise<{ readonly revokeStatus: number | "transport-error"; readonly replayStatus: 401 }> {
  let revokeStatus: number | "transport-error" = "transport-error";
  try {
    const response = await fetcher(`${origin}/v1/session`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${sessionToken}`, "cache-control": "no-store" },
      redirect: "error",
    });
    revokeStatus = response.status;
  } catch {
    // The read-only replay settles a lost acknowledgement. Never retry DELETE.
  }
  let replay: Response;
  try {
    replay = await fetcher(`${origin}/v1/me`, {
      method: "GET",
      headers: { authorization: `Bearer ${sessionToken}`, "cache-control": "no-store" },
      redirect: "error",
    });
  } catch {
    throw phaseError(
      phase,
      "operator authority session revocation replay failed; session state is indeterminate and redacted",
    );
  }
  if (replay.status !== 401) {
    throw phaseError(
      phase,
      "operator authority proof session remains usable after revocation",
      `revoke_status=${revokeStatus} replay_status=${replay.status}`,
    );
  }
  return { revokeStatus, replayStatus: 401 };
}

function readOwnedJson(path: string, label: string): unknown {
  let descriptor: number | null = null;
  let raw: string;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const status = fstatSync(descriptor);
    if (
      !status.isFile() ||
      status.nlink !== 1 ||
      (typeof process.getuid === "function" && status.uid !== process.getuid()) ||
      (status.mode & 0o7777) !== 0o600 ||
      status.size < 1 ||
      status.size > MAX_INPUT_BYTES
    ) {
      throw new Error("unsafe");
    }
    raw = readFileSync(descriptor, "utf8");
  } catch {
    throw preflightError(`${label} must be an owned 0600 link-free regular file of at most 16 KiB`);
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw preflightError(`${label} is not valid JSON`);
  }
}

function exactPrincipal(
  value: unknown,
  identity: OperatorSignInIdentity,
  phase: DeployPhase,
): Record<string, unknown> {
  if (
    !isRecord(value) ||
    !exactKeys(value, PRINCIPAL_KEYS) ||
    !boundedText(value.id) ||
    value.provider !== identity.provider ||
    value.providerSubject !== identity.subject ||
    value.email !== identity.email ||
    value.displayName !== identity.displayName
  ) {
    throw phaseError(phase, "operator authority returned a different or malformed principal");
  }
  return value;
}

function exactOrganizations(
  value: readonly unknown[],
  phase: DeployPhase,
): readonly {
  readonly id: string;
  readonly name: string;
  readonly ownerPrincipalId: string;
  readonly createdAt: string;
}[] {
  const organizations = value.map((entry) => exactOrganization(entry, phase));
  if (new Set(organizations.map(({ id }) => id)).size !== organizations.length) {
    throw phaseError(phase, "operator authority /v1/me returned duplicate organizations");
  }
  return organizations;
}

function exactOrganization(
  value: unknown,
  phase: DeployPhase,
): {
  readonly id: string;
  readonly name: string;
  readonly ownerPrincipalId: string;
  readonly createdAt: string;
} {
  if (
    !isRecord(value) ||
    !exactKeys(value, ORGANIZATION_KEYS) ||
    !boundedText(value.id) ||
    !boundedText(value.name) ||
    !boundedText(value.ownerPrincipalId) ||
    typeof value.createdAt !== "string" ||
    !Number.isFinite(Date.parse(value.createdAt))
  ) {
    throw phaseError(phase, "operator authority returned a malformed organization");
  }
  return {
    id: value.id as string,
    name: value.name as string,
    ownerPrincipalId: value.ownerPrincipalId as string,
    createdAt: value.createdAt,
  };
}

function combinedAuthorityFailure(
  primary: unknown,
  cleanup: unknown,
  fallbackPhase: DeployPhase,
): DeployError {
  const primaryFailure = sanitizedFailure(primary, fallbackPhase);
  const cleanupFailure = sanitizedFailure(cleanup, "verification");
  return phaseError(
    primaryFailure.phase,
    primaryFailure.message,
    JSON.stringify({ primary: primaryFailure, cleanup: cleanupFailure }),
  );
}

function sanitizedFailure(
  failure: unknown,
  fallbackPhase: DeployPhase,
): { readonly phase: DeployPhase; readonly message: string } {
  return failure instanceof DeployError
    ? { phase: failure.phase, message: failure.message }
    : {
        phase: fallbackPhase,
        message: "operator authority operation failed; credentials redacted",
      };
}

function boundedText(value: unknown): boolean {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 256 &&
    value.trim() === value &&
    ![...value].some((character) => {
      const code = character.codePointAt(0);
      return code !== undefined && (code <= 31 || code === 127);
    })
  );
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function phaseError(phase: DeployPhase, message: string, detail?: string) {
  if (phase === "preflight") return preflightError(message, detail);
  if (phase === "mutation") return mutationError(message, detail);
  return verificationError(message, detail);
}

function errorCode(value: unknown): string | null {
  if (!isRecord(value) || !isRecord(value.error)) return null;
  return typeof value.error.code === "string" ? value.error.code : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
