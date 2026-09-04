import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import {
  ARTIFACT_RECOVERY_APPLY_FORMAT,
  type ArtifactRecoveryLostAckAuthorization,
  type ArtifactRecoveryRequest,
  canonicalArtifactRecoveryRequest,
  parseArtifactRecoveryLostAckAuthorization,
} from "../src/artifact-recovery.ts";
import { exactArtifactRecoveryActionPath } from "../src/exact-artifact-recovery-operator-proof.ts";
import { canonicalJson, isSha256Digest } from "../src/json.ts";
import { signOperatorAssertion } from "../src/operator-key.ts";
import { parseStrictJson } from "../src/strict-json.ts";
import { readPrivateJwk } from "./deploy/identity.ts";

const MAX_DESCRIPTOR_BYTES = 128 * 1_024;
const MAX_RESPONSE_BYTES = 256 * 1_024;
const ASSERTION_LIFETIME_SECONDS = 60;

export interface LoadedExactArtifactRecoveryRequest {
  readonly request: ArtifactRecoveryRequest;
  readonly requestDigest: `sha256:${string}`;
}

/**
 * Reads one canonical descriptor from an operator-owned, outside-repository
 * file. Neither the returned value nor its source path is ever logged here.
 */
export async function loadExactArtifactRecoveryRequest(
  path: string,
): Promise<LoadedExactArtifactRecoveryRequest> {
  const normalized = exactPrivatePath(path);
  const raw = readExactPrivateFile(normalized);
  const parsed = parseStrictJson(raw, MAX_DESCRIPTOR_BYTES);
  const canonical = await canonicalArtifactRecoveryRequest(parsed);
  if (new TextDecoder("utf-8", { fatal: true }).decode(raw) !== canonical.canonicalJson) {
    throw new Error("exact artifact recovery request file is not canonical JSON");
  }
  return { request: canonical.request, requestDigest: canonical.requestDigest };
}

/** Optional reviewed successor authority; kept distinct from the singleton request digest. */
export function loadExactArtifactRecoveryLostAck(
  path: string,
): ArtifactRecoveryLostAckAuthorization {
  const raw = readExactPrivateFile(exactPrivatePath(path));
  const text = new TextDecoder("utf-8", { fatal: true }).decode(raw);
  const parsed = parseExactArtifactRecoveryLostAck(text);
  if (canonicalJson(parsed) !== text) {
    throw new Error("exact artifact recovery lost-ack file is not canonical JSON");
  }
  return parsed;
}

export function parseExactArtifactRecoveryLostAck(
  value: string,
): ArtifactRecoveryLostAckAuthorization {
  const bytes = new TextEncoder().encode(value);
  const parsed = parseStrictJson(bytes, MAX_DESCRIPTOR_BYTES);
  if (canonicalJson(parsed) !== value) {
    throw new Error("exact artifact recovery lost-ack descriptor is not canonical JSON");
  }
  return parseArtifactRecoveryLostAckAuthorization(parsed);
}

function readExactPrivateFile(normalized: string): Uint8Array {
  let descriptor: number | null = null;
  let raw: Uint8Array;
  try {
    descriptor = openSync(normalized, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = fstatSync(descriptor, { bigint: true });
    if (
      !before.isFile() ||
      before.nlink !== 1n ||
      (typeof process.getuid === "function" && before.uid !== BigInt(process.getuid())) ||
      (before.mode & 0o7777n) !== 0o600n ||
      before.size < 2n ||
      before.size > BigInt(MAX_DESCRIPTOR_BYTES)
    ) {
      throw new Error("unsafe");
    }
    raw = readFileSync(descriptor);
    const after = fstatSync(descriptor, { bigint: true });
    if (
      BigInt(raw.byteLength) !== before.size ||
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.uid !== before.uid ||
      after.mode !== before.mode ||
      after.nlink !== before.nlink ||
      after.size !== before.size ||
      after.mtimeNs !== before.mtimeNs ||
      after.ctimeNs !== before.ctimeNs
    ) {
      throw new Error("unsafe");
    }
  } catch {
    throw new Error("exact artifact recovery request must be one owned 0600 link-free file");
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
  return raw;
}

async function main(): Promise<void> {
  const action = exactAction(process.argv.slice(2));
  const result = await runExactArtifactRecoveryOperator({
    action,
    requestPath: requiredEnvironment("TAKOSERVER_EXACT_ARTIFACT_RECOVERY_REQUEST_PATH"),
    workerVersionId: requiredWorkerVersion("TAKOSERVER_EXACT_ARTIFACT_RECOVERY_WORKER_VERSION_ID"),
    gatewayOrigin: exactOrigin(
      requiredEnvironment("TAKOSERVER_EXACT_ARTIFACT_RECOVERY_GATEWAY_ORIGIN"),
    ),
    identity: {
      hostId: requiredEnvironment("TAKOSERVER_EXACT_ARTIFACT_RECOVERY_HOST_ID"),
      workerArtifactDigest: requiredDigest(
        "TAKOSERVER_EXACT_ARTIFACT_RECOVERY_PUBLIC_WORKER_ARTIFACT_DIGEST",
      ),
      publicWorkerVersionId: requiredWorkerVersion(
        "TAKOSERVER_EXACT_ARTIFACT_RECOVERY_PUBLIC_WORKER_VERSION_ID",
      ),
      implementationDigest: requiredDigest(
        "TAKOSERVER_EXACT_ARTIFACT_RECOVERY_IMPLEMENTATION_DIGEST",
      ),
    },
    privateJwkPath: requiredEnvironment("TAKOSERVER_FORM_AUTHORITY_OPERATOR_PRIVATE_JWK_PATH"),
  });
  process.stdout.write(`${canonicalJson(result)}\n`);
}

export interface ExactArtifactRecoveryOperatorInvocation {
  readonly action: "status" | "apply" | "purge";
  readonly requestPath: string;
  readonly workerVersionId: string;
  readonly gatewayOrigin: string;
  readonly identity: {
    readonly hostId: string;
    readonly workerArtifactDigest: `sha256:${string}`;
    readonly publicWorkerVersionId: string;
    readonly implementationDigest: `sha256:${string}`;
  };
  readonly privateJwkPath: string;
  readonly fetcher?: typeof fetch;
  readonly now?: () => number;
}

/** Shared operator invocation used by the CLI and the owning deploy surface. */
export async function runExactArtifactRecoveryOperator(
  input: ExactArtifactRecoveryOperatorInvocation,
): Promise<unknown> {
  const loaded = await loadExactArtifactRecoveryRequest(input.requestPath);
  const workerVersionId = exactWorkerVersion(input.workerVersionId);
  const gatewayOrigin = exactOrigin(input.gatewayOrigin);
  const identity = {
    ...input.identity,
    publicWorkerVersionId: exactWorkerVersion(input.identity.publicWorkerVersionId),
    workerArtifactDigest: exactDigest(input.identity.workerArtifactDigest),
    implementationDigest: exactDigest(input.identity.implementationDigest),
    recoveryWorkerVersionId: workerVersionId,
    requestDigest: loaded.requestDigest,
  } as const;
  const privateJwk = JSON.stringify(readPrivateJwk(input.privateJwkPath).jwk);
  if (input.action === "purge") {
    return await callGateway({
      action: "purge",
      body: loaded.request,
      gatewayOrigin,
      identity,
      privateJwk,
      ...(input.fetcher === undefined ? {} : { fetcher: input.fetcher }),
      ...(input.now === undefined ? {} : { now: input.now }),
    });
  }
  const status = await callGateway({
    action: "status",
    body: loaded.request,
    gatewayOrigin,
    identity,
    privateJwk,
    ...(input.fetcher === undefined ? {} : { fetcher: input.fetcher }),
    ...(input.now === undefined ? {} : { now: input.now }),
  });
  if (input.action === "status" || !record(status) || status.action === "none") {
    return status;
  }
  if (!isSha256Digest(status.planDigest)) {
    throw new Error("exact artifact recovery gateway returned an invalid status");
  }
  const applied = await callGateway({
    action: "apply",
    body: {
      kind: ARTIFACT_RECOVERY_APPLY_FORMAT,
      request: loaded.request,
      planDigest: status.planDigest,
    },
    gatewayOrigin,
    identity,
    privateJwk,
    ...(input.fetcher === undefined ? {} : { fetcher: input.fetcher }),
    ...(input.now === undefined ? {} : { now: input.now }),
  });
  return applied;
}

async function callGateway(input: {
  readonly action: "status" | "apply" | "purge";
  readonly body: unknown;
  readonly gatewayOrigin: string;
  readonly identity: {
    readonly hostId: string;
    readonly workerArtifactDigest: `sha256:${string}`;
    readonly publicWorkerVersionId: string;
    readonly implementationDigest: `sha256:${string}`;
    readonly requestDigest: `sha256:${string}`;
    readonly recoveryWorkerVersionId: string;
  };
  readonly privateJwk: string;
  readonly fetcher?: typeof fetch;
  readonly now?: () => number;
}): Promise<unknown> {
  const bodyDigest = `sha256:${createHash("sha256").update(canonicalJson(input.body)).digest("hex")}`;
  const path = exactArtifactRecoveryActionPath(input.action);
  const nowSeconds = Math.floor((input.now?.() ?? Date.now()) / 1_000);
  const assertion = await signOperatorAssertion({
    privateJwk: input.privateJwk,
    nowSeconds,
    lifetimeSeconds: ASSERTION_LIFETIME_SECONDS,
    claims: {
      purpose: "exact-artifact-recovery",
      action: input.action,
      method: "POST",
      path,
      bodyDigest,
      environment: "integration",
      ...input.identity,
    },
  });
  const response = await (input.fetcher ?? fetch)(`${input.gatewayOrigin}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${assertion}`, "content-type": "application/json" },
    body: canonicalJson(input.body),
  });
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength < 2 || bytes.byteLength > MAX_RESPONSE_BYTES) {
    throw new Error("exact artifact recovery gateway returned an invalid response");
  }
  const value = parseStrictJson(bytes, MAX_RESPONSE_BYTES);
  if (!response.ok) throw new Error(`exact artifact recovery gateway refused: ${response.status}`);
  if (!record(value) || "request" in value || "owners" in value || "memberDigests" in value) {
    throw new Error("exact artifact recovery gateway returned unsafe detail");
  }
  return value;
}

function exactDigest(value: string): `sha256:${string}` {
  if (!isSha256Digest(value)) throw new Error("exact artifact recovery digest is invalid");
  return value;
}

function exactWorkerVersion(value: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(value)) {
    throw new Error("exact artifact recovery Worker Version is invalid");
  }
  return value;
}

function exactPrivatePath(path: string): string {
  if (!isAbsolute(path) || resolve(path) !== path) {
    throw new Error("exact artifact recovery request path must be absolute and canonical");
  }
  let current: string = sep;
  for (const part of path.split(sep).filter(Boolean)) {
    current = join(current, part);
    const status = lstatSync(current);
    if (status.isSymbolicLink() || (current !== path && !status.isDirectory())) {
      throw new Error("exact artifact recovery request path is not link-free");
    }
  }
  const parent = dirname(path);
  const parentStatus = lstatSync(parent);
  if (
    !parentStatus.isDirectory() ||
    (parentStatus.mode & 0o7777) !== 0o700 ||
    (typeof process.getuid === "function" && parentStatus.uid !== process.getuid())
  ) {
    throw new Error("exact artifact recovery request parent must be owned mode 0700");
  }
  for (let cursor = parent; ; cursor = dirname(cursor)) {
    if (existsSync(join(cursor, ".git"))) {
      throw new Error("exact artifact recovery request must stay outside every Git worktree");
    }
    const next = dirname(cursor);
    if (next === cursor) break;
  }
  return path;
}

function exactAction(args: readonly string[]): "status" | "apply" {
  if (args.length !== 1 || (args[0] !== "--status" && args[0] !== "--apply")) {
    throw new Error("usage: bun scripts/exact-artifact-recovery.ts --status|--apply");
  }
  return args[0] === "--status" ? "status" : "apply";
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() !== value) throw new Error(`${name} is required`);
  return value;
}

function requiredDigest(name: string): `sha256:${string}` {
  const value = requiredEnvironment(name);
  if (!isSha256Digest(value)) throw new Error(`${name} is invalid`);
  return value;
}

function requiredWorkerVersion(name: string): string {
  const value = requiredEnvironment(name);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(value)) {
    throw new Error(`${name} is invalid`);
  }
  return value;
}

function exactOrigin(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.origin !== value ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    url.hostname.endsWith(".workers.dev")
  ) {
    throw new Error("exact artifact recovery gateway origin is invalid");
  }
  return value;
}

function record(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

if (import.meta.main) {
  await main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : "exact artifact recovery failed"}\n`,
    );
    process.exitCode = 1;
  });
}
