import { existsSync, lstatSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { API_KEY_SCOPES, type ApiKeyScope } from "../../src/auth.ts";
import { mutationError, preflightError, verificationError } from "./errors.ts";
import {
  OPERATOR_IDENTITY_ENV,
  OPERATOR_PRIVATE_JWK_ENV,
  type OperatorAuthoritySession,
  provePrivateMatchesPublic,
  readOperatorSignInIdentity,
  readPrivateJwk,
  withOperatorOwnerSession,
} from "./operator-authority.ts";
import { type CommandResult, requireEnvironment, runCommand } from "./process.ts";
import { type DeployEnvironment, qualifySource } from "./qualification.ts";
import type { DeployTarget } from "./target.ts";
import { probeProduct } from "./worker.ts";

/**
 * Durable organization API keys, minted through operator authority.
 *
 * Takoserver had two ways to obtain an organization API key and neither could
 * serve a Worker secret. The console route needs an interactive owner session,
 * which an unattended deploy does not have. The integration JIT surface issues
 * a pair whose TTL a D1 `CHECK` fixes at one hour — a smoke-window credential,
 * so a Hosted Worker installed with one starts failing an hour later. A
 * long-lived credential therefore had no minting surface at all, and the gap
 * was filled by pasting a key out of a browser.
 *
 * This surface closes it without inventing a second issuance path: it proves
 * the operator's own Ed25519 identity, exchanges it for the same owner session
 * the console uses, and calls the same `POST /v1/organizations/{id}/api-keys`
 * route. The key lands in the one `auth_tokens` record every other key lives
 * in, so the console lists it, the console can revoke it, and this surface's
 * own `--status` and `--revoke` read and settle the same rows.
 *
 * Expiry is declared, never unbounded: a key that never expires is a key
 * nobody ever has to think about again, which is how a credential outlives the
 * reason it existed.
 */

export { OPERATOR_IDENTITY_ENV, OPERATOR_PRIVATE_JWK_ENV } from "./operator-authority.ts";
export const OUTPUT_DIRECTORY_ENV = "TAKOSERVER_ORG_API_KEY_OUTPUT_DIRECTORY";

/** Long enough for a release to live on, short enough to be re-decided. */
export const MAX_ORG_API_KEY_EXPIRY_DAYS = 730;

const ORGANIZATION_ID = /^org_[A-Za-z0-9][A-Za-z0-9._:-]{0,123}$/u;
/** Also the secret file name, so it stays a plain lowercase path segment. */
const KEY_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/u;
const API_KEY_ID = /^key_[A-Za-z0-9][A-Za-z0-9._:-]{0,123}$/u;
const SECONDS_PER_DAY = 86_400;

export type OrgApiKeyAction = "mint" | "status" | "revoke";

export interface OrgApiKeyInvocation {
  readonly surface: "takoserver-org-api-key";
  readonly action: OrgApiKeyAction;
  readonly environment: DeployEnvironment;
  readonly commit: string;
  readonly organizationId: string;
  /** `--mint`: the operator's handle on the key, and its secret file name. */
  readonly keyName?: string;
  readonly scopes?: readonly ApiKeyScope[];
  readonly expiresInDays?: number;
  /** `--revoke`: the exact key id `--status` printed. */
  readonly apiKeyId?: string;
}

export type OrgApiKeyProcess = (
  command: readonly string[],
  options?: { readonly env?: Readonly<Record<string, string>>; readonly input?: string },
) => Promise<CommandResult>;

export interface OrgApiKeyOptions {
  readonly run?: OrgApiKeyProcess;
  readonly fetcher?: (input: string, init?: RequestInit) => Promise<Response>;
  readonly review?: string;
  readonly privateJwkPath?: string;
  readonly operatorIdentityPath?: string;
  readonly outputDirectory?: string;
  readonly now?: () => Date;
}

interface LiveApiKey {
  readonly id: string;
  readonly organizationId: string;
  readonly name: string;
  readonly scopes: readonly string[];
  readonly createdAt: string;
  readonly expiresAt: string;
}

export async function runOrgApiKey(
  invocation: OrgApiKeyInvocation,
  target: DeployTarget,
  options: OrgApiKeyOptions = {},
): Promise<Record<string, unknown>> {
  if (target.environment !== invocation.environment) {
    throw preflightError("organization API key invocation and target environments differ");
  }
  if (!ORGANIZATION_ID.test(invocation.organizationId)) {
    throw preflightError("--organization must be one exact organization id");
  }
  const identityAuthority = target.operatorIdentity;
  if (identityAuthority === undefined) {
    throw preflightError(
      "selected target declares no operatorIdentity, so no operator authority can mint a key here",
      "Declare `operatorIdentity.publicJwk` in the operator-private descriptor and publish it " +
        "through takoserver-integration-operator-identity first.",
    );
  }
  const request = assertActionShape(invocation);
  const run = options.run ?? runCommand;
  const fetcher = options.fetcher ?? ((input, init) => fetch(input, init));
  const now = options.now ?? (() => new Date());
  const source = await qualifySource({
    environment: invocation.environment,
    commit: invocation.commit,
    run,
  });
  // The mutating actions are authority actions; the readback is not.
  const reviewer =
    invocation.action === "status"
      ? undefined
      : exactReviewer(options.review ?? requireEnvironment("TAKOSERVER_INDEPENDENT_REVIEW"));
  const outputDirectory =
    invocation.action === "mint"
      ? ownedSecretDirectory(options.outputDirectory ?? requireEnvironment(OUTPUT_DIRECTORY_ENV))
      : null;
  const privateJwk = readPrivateJwk(
    options.privateJwkPath ?? requireEnvironment(OPERATOR_PRIVATE_JWK_ENV),
  );
  await provePrivateMatchesPublic(privateJwk, identityAuthority.publicJwk);
  const identity = readOperatorSignInIdentity(
    options.operatorIdentityPath ?? requireEnvironment(OPERATOR_IDENTITY_ENV),
  );
  // The Host must be the product this target names before any credential moves.
  const probe = await probeProduct(target.publicOrigin, fetcher);

  const authority = await withOperatorOwnerSession(
    {
      origin: target.publicOrigin,
      organizationId: invocation.organizationId,
      privateInput: privateJwk,
      identity,
      fetcher,
      now,
      phase: "preflight",
      cleanupPhase: invocation.action === "status" ? "preflight" : "verification",
    },
    async (session) => {
      const before = await listApiKeys(session, invocation.organizationId);

      if (invocation.action === "status") {
        return {
          kind: "takoserver.org-api-key-status@v1",
          surface: invocation.surface,
          action: invocation.action,
          environment: invocation.environment,
          selectedCommit: source.commit,
          dirty: source.dirty,
          organizationId: invocation.organizationId,
          probe,
          apiKeys: before,
          secretsRedacted: true,
          mutationApplied: false,
          ready: true,
        };
      }

      if (invocation.action === "revoke") {
        const apiKeyId = request.apiKeyId;
        const revoked = await revokeApiKey(session, invocation.organizationId, apiKeyId);
        const after = await listApiKeys(session, invocation.organizationId);
        if (after.some((key) => key.id === apiKeyId)) {
          throw verificationError("revoked organization API key is still listed as unrevoked");
        }
        return {
          kind: "takoserver.org-api-key-revoke@v1",
          surface: invocation.surface,
          action: invocation.action,
          environment: invocation.environment,
          commit: source.commit,
          dirty: source.dirty,
          remoteRef: source.remoteRef,
          reviewer,
          organizationId: invocation.organizationId,
          apiKeyId,
          revokedKeyName: revoked.name,
          apiKeys: after,
          secretsRedacted: true,
          mutationApplied: true,
          reversal:
            "forward only: a revoked key is never restored; mint a new key and re-install it",
        };
      }

      const keyName = request.keyName;
      const scopes = request.scopes;
      const expiresInSeconds = request.expiresInDays * SECONDS_PER_DAY;
      const secretPath = join(
        outputDirectory as string,
        `${invocation.organizationId}.${keyName}.secret`,
      );
      if (existsSync(secretPath)) {
        throw preflightError(
          "an organization API key secret file with this name already exists",
          "Revoke the key it holds through this surface and remove the file before minting again.",
        );
      }
      // A duplicate live name would leave two keys the operator cannot tell
      // apart, and only one of them would have a secret on disk.
      const conflict = before.find((key) => key.name === keyName);
      if (conflict) {
        throw preflightError(
          `organization ${invocation.organizationId} already has an unrevoked API key named ${keyName}`,
          JSON.stringify({ apiKeyId: conflict.id, expiresAt: conflict.expiresAt }),
        );
      }
      const minted = await mintApiKey(session, {
        organizationId: invocation.organizationId,
        name: keyName,
        scopes,
        expiresInSeconds,
      });
      // The secret exists in exactly two places from here: this file and the
      // Host's digest. It never enters stdout, argv or a diagnostic.
      writeFileSync(secretPath, minted.secret, { mode: 0o600, flag: "wx" });
      const after = await listApiKeys(session, invocation.organizationId);
      const readback = after.find((key) => key.id === minted.apiKey.id);
      if (
        !readback ||
        readback.name !== keyName ||
        readback.expiresAt !== minted.apiKey.expiresAt
      ) {
        throw verificationError(
          "minted organization API key is not listed with its exact identity",
        );
      }
      return {
        kind: "takoserver.org-api-key-mint@v1",
        surface: invocation.surface,
        action: invocation.action,
        environment: invocation.environment,
        commit: source.commit,
        dirty: source.dirty,
        remoteRef: source.remoteRef,
        reviewer,
        organizationId: invocation.organizationId,
        apiKeyId: readback.id,
        keyName,
        scopes: readback.scopes,
        createdAt: readback.createdAt,
        expiresAt: readback.expiresAt,
        expiresInDays: request.expiresInDays,
        secretPath,
        secretsRedacted: true,
        probe,
        mutationApplied: true,
        reversal:
          `bun run deploy -- takoserver-org-api-key --revoke --environment=${invocation.environment} ` +
          `--commit=${source.commit} --organization=${invocation.organizationId} ` +
          `--key-id=${readback.id}`,
      };
    },
  );
  return authority.value;
}

interface ActionShape {
  readonly keyName: string;
  readonly scopes: readonly ApiKeyScope[];
  readonly expiresInDays: number;
  readonly apiKeyId: string;
}

/** Each action names exactly the operands it uses; a stray one is a refusal. */
function assertActionShape(invocation: OrgApiKeyInvocation): ActionShape {
  const mint = invocation.action === "mint";
  const revoke = invocation.action === "revoke";
  if (mint) {
    const keyName = invocation.keyName;
    const scopes = invocation.scopes ?? [];
    const expiresInDays = invocation.expiresInDays;
    if (keyName === undefined || !KEY_NAME.test(keyName)) {
      throw preflightError("--key-name must be one lowercase dash-separated name of 1..64 bytes");
    }
    if (
      scopes.length === 0 ||
      new Set(scopes).size !== scopes.length ||
      scopes.some((scope) => !API_KEY_SCOPES.includes(scope))
    ) {
      throw preflightError(
        "--scope must name distinct known API key scopes",
        JSON.stringify([...API_KEY_SCOPES]),
      );
    }
    if (
      expiresInDays === undefined ||
      !Number.isSafeInteger(expiresInDays) ||
      expiresInDays < 1 ||
      expiresInDays > MAX_ORG_API_KEY_EXPIRY_DAYS
    ) {
      throw preflightError(
        `--expires-in-days must be an integer of 1..${MAX_ORG_API_KEY_EXPIRY_DAYS}; ` +
          "an organization API key is never issued unbounded",
      );
    }
    if (invocation.apiKeyId !== undefined) {
      throw preflightError("--key-id belongs to --revoke, not --mint");
    }
    return { keyName, scopes, expiresInDays, apiKeyId: "" };
  }
  if (invocation.keyName !== undefined || invocation.scopes !== undefined) {
    throw preflightError("--key-name and --scope belong to --mint");
  }
  if (invocation.expiresInDays !== undefined) {
    throw preflightError("--expires-in-days belongs to --mint");
  }
  if (revoke) {
    const apiKeyId = invocation.apiKeyId;
    if (apiKeyId === undefined || !API_KEY_ID.test(apiKeyId)) {
      throw preflightError("--revoke requires the exact --key-id that --status printed");
    }
    return { keyName: "", scopes: [], expiresInDays: 0, apiKeyId };
  }
  if (invocation.apiKeyId !== undefined) {
    throw preflightError("--key-id belongs to --revoke");
  }
  return { keyName: "", scopes: [], expiresInDays: 0, apiKeyId: "" };
}

async function listApiKeys(
  session: OperatorAuthoritySession,
  organizationId: string,
): Promise<readonly LiveApiKey[]> {
  let response: Response;
  try {
    response = await session.request(
      `/v1/organizations/${encodeURIComponent(organizationId)}/api-keys`,
      { method: "GET" },
    );
  } catch {
    throw preflightError("organization API key readback transport failed");
  }
  const body = (await response.json().catch(() => null)) as unknown;
  if (response.status !== 200 || !isRecord(body) || !Array.isArray(body.apiKeys)) {
    throw preflightError(
      "organization API key readback was refused or malformed",
      `status=${response.status}`,
    );
  }
  return body.apiKeys.map((entry) => exactApiKey(entry, organizationId));
}

async function mintApiKey(
  session: OperatorAuthoritySession,
  input: {
    readonly organizationId: string;
    readonly name: string;
    readonly scopes: readonly ApiKeyScope[];
    readonly expiresInSeconds: number;
  },
): Promise<{ readonly apiKey: LiveApiKey; readonly secret: string }> {
  let response: Response;
  try {
    response = await session.request(
      `/v1/organizations/${encodeURIComponent(input.organizationId)}/api-keys`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          name: input.name,
          scopes: [...input.scopes],
          expiresInSeconds: input.expiresInSeconds,
        }),
        redirect: "error",
      },
    );
  } catch {
    throw mutationError(
      "organization API key mint acknowledgement is indeterminate; do not retry before --status",
    );
  }
  const body = (await response.json().catch(() => null)) as unknown;
  if (response.status !== 201 || !isRecord(body) || typeof body.secret !== "string") {
    throw mutationError(
      "organization API key mint was refused or returned no usable secret; do not retry before --status",
      `status=${response.status}`,
    );
  }
  const secret = body.secret;
  if (secret.length < 16 || secret.length > 512) {
    throw mutationError(
      "organization API key mint returned an unusable secret; do not retry before --status",
    );
  }
  return { apiKey: exactApiKey(body.apiKey, input.organizationId), secret };
}

async function revokeApiKey(
  session: OperatorAuthoritySession,
  organizationId: string,
  apiKeyId: string,
): Promise<LiveApiKey> {
  let response: Response;
  try {
    response = await session.request(
      `/v1/organizations/${encodeURIComponent(organizationId)}/api-keys/` +
        encodeURIComponent(apiKeyId),
      {
        method: "DELETE",
      },
    );
  } catch {
    throw mutationError(
      "organization API key revoke acknowledgement is indeterminate; do not retry before --status",
    );
  }
  const body = (await response.json().catch(() => null)) as unknown;
  if (response.status !== 200 || !isRecord(body)) {
    throw mutationError(
      "organization API key revoke was refused; do not retry before --status",
      `status=${response.status}`,
    );
  }
  return exactApiKey(body.apiKey, organizationId);
}

/** Only the exact nonsecret projection travels; an unexpected member fails closed. */
function exactApiKey(value: unknown, organizationId: string): LiveApiKey {
  if (
    !isRecord(value) ||
    JSON.stringify(Object.keys(value).sort()) !==
      JSON.stringify(["createdAt", "expiresAt", "id", "name", "organizationId", "scopes"]) ||
    typeof value.id !== "string" ||
    !API_KEY_ID.test(value.id) ||
    value.organizationId !== organizationId ||
    typeof value.name !== "string" ||
    !Array.isArray(value.scopes) ||
    value.scopes.some((scope) => typeof scope !== "string") ||
    typeof value.createdAt !== "string" ||
    typeof value.expiresAt !== "string" ||
    !Number.isFinite(Date.parse(value.expiresAt))
  ) {
    throw preflightError("organization API key projection is not the exact nonsecret shape");
  }
  return {
    id: value.id,
    organizationId,
    name: value.name,
    scopes: value.scopes as readonly string[],
    createdAt: value.createdAt,
    expiresAt: value.expiresAt,
  };
}

function ownedSecretDirectory(path: string): string {
  if (!isAbsolute(path)) throw preflightError(`${OUTPUT_DIRECTORY_ENV} must be one absolute path`);
  const normalized = resolve(path);
  let status: ReturnType<typeof lstatSync>;
  try {
    status = lstatSync(normalized);
  } catch {
    throw preflightError(`${OUTPUT_DIRECTORY_ENV} is unavailable`);
  }
  if (
    !status.isDirectory() ||
    status.isSymbolicLink() ||
    (status.mode & 0o7777) !== 0o700 ||
    (typeof process.getuid === "function" && status.uid !== process.getuid())
  ) {
    throw preflightError(`${OUTPUT_DIRECTORY_ENV} must be an owned exact 0700 link-free directory`);
  }
  for (let cursor = normalized; ; cursor = dirname(cursor)) {
    if (existsSync(join(cursor, ".git"))) {
      throw preflightError(`${OUTPUT_DIRECTORY_ENV} must stay outside every Git worktree`);
    }
    const next = dirname(cursor);
    if (next === cursor) break;
  }
  if (normalized.split(sep).some((part) => part === "..")) {
    throw preflightError(`${OUTPUT_DIRECTORY_ENV} must be one normalized absolute path`);
  }
  return normalized;
}

function exactReviewer(value: string): string {
  if (value.trim() !== value || value.length < 1 || value.length > 256 || value.includes("\n")) {
    throw preflightError("TAKOSERVER_INDEPENDENT_REVIEW must name one reviewer");
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
