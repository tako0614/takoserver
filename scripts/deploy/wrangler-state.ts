import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { DeployError, mutationError, preflightError } from "./errors.ts";
import { type CommandResult, runCommand, wranglerCommand } from "./process.ts";
import type { WorkerState } from "./worker-live.ts";
import { parseWorkerDeploymentChain, parseWorkerSecretInventory } from "./worker-state.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const ACCOUNT_ID = /^[0-9a-f]{32}$/u;
const WORKER_NAME = /^[a-z0-9][a-z0-9-]{1,62}$/u;
const BOOT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const PROCESS_START_TICKS = /^[1-9][0-9]*$/u;
const LEASE_OWNER_KIND = "takoserver.worker-publication-lease-owner@v1" as const;
const MAX_LEASE_OWNER_BYTES = 4096;

export type WranglerProcess = (
  command: readonly string[],
  options?: { readonly env?: Readonly<Record<string, string>>; readonly input?: string },
) => Promise<CommandResult>;

export interface WranglerWorkerStateOptions {
  readonly configPath: string;
  readonly workerName: string;
  /** Validated target declaration; deliberately never treated as live topology proof. */
  readonly publicOrigin?: string;
  readonly environment?: Readonly<Record<string, string>>;
  readonly run?: WranglerProcess;
}

/**
 * Partial read-only Worker state through Wrangler's own authenticated commands.
 *
 * Wrangler resolves its stored OAuth profile inside each child process. The
 * adapter deliberately has no token resolver and never invokes a credential
 * extraction command. Wrangler exposes no supported exhaustive topology
 * reader, so `workerDomains` always fails closed and this adapter is not wired
 * into publication authority.
 */
export class WranglerWorkerState implements WorkerState {
  readonly #configPath: string;
  readonly #workerName: string;
  readonly #environment: Readonly<Record<string, string>>;
  readonly #run: WranglerProcess;

  constructor(input: WranglerWorkerStateOptions) {
    if (!isAbsolute(input.configPath) || input.configPath.length === 0) {
      throw preflightError("Wrangler Worker state requires one absolute config path");
    }
    if (!WORKER_NAME.test(input.workerName)) {
      throw preflightError("Wrangler Worker state requires one exact Worker name");
    }
    if (input.environment?.CLOUDFLARE_API_TOKEN !== undefined) {
      throw preflightError(
        "Wrangler OAuth state must not receive CLOUDFLARE_API_TOKEN; use direct REST state",
      );
    }
    if (input.publicOrigin !== undefined) {
      try {
        const origin = new URL(input.publicOrigin);
        if (
          origin.protocol !== "https:" ||
          origin.username ||
          origin.password ||
          origin.port ||
          origin.pathname !== "/" ||
          origin.search ||
          origin.hash
        ) {
          throw new Error("origin");
        }
      } catch {
        throw preflightError("Wrangler Worker state requires one exact HTTPS public origin");
      }
    }
    this.#configPath = input.configPath;
    this.#workerName = input.workerName;
    this.#environment = Object.freeze({ ...(input.environment ?? {}) });
    this.#run = input.run ?? runCommand;
  }

  async workerDeployments(workerName: string): Promise<readonly unknown[]> {
    this.#assertWorker(workerName);
    const value = await this.#json(
      ["deployments", "list", "--name", workerName, "--config", this.#configPath, "--json"],
      `${workerName} Wrangler deployment history`,
    );
    return parseWranglerDeploymentOutputValue(value, workerName);
  }

  async workerVersion(workerName: string, versionId: string): Promise<unknown> {
    this.#assertWorker(workerName);
    if (!UUID.test(versionId)) {
      throw preflightError("Wrangler Worker state requires one exact Version ID");
    }
    const value = await this.#json(
      ["versions", "view", versionId, "--name", workerName, "--config", this.#configPath, "--json"],
      `${workerName} Wrangler Version ${versionId}`,
    );
    return parseWranglerVersionOutputValue(value, versionId);
  }

  async workerSecrets(workerName: string): Promise<readonly unknown[]> {
    this.#assertWorker(workerName);
    const value = await this.#json(
      ["secret", "list", "--name", workerName, "--format", "json", "--config", this.#configPath],
      `${workerName} Wrangler secret inventory`,
    );
    return parseWranglerSecretOutputValue(value);
  }

  async workerDomains(): Promise<
    readonly { readonly hostname: string; readonly service: string }[]
  > {
    throw preflightError(
      "Wrangler OAuth cannot prove workers.dev enabled state or exhaustive custom-domain inventory; " +
        "use CLOUDFLARE_API_TOKEN and direct REST state",
    );
  }

  async workerSubdomain(workerName: string): Promise<{
    readonly enabled: boolean;
    readonly previewsEnabled: boolean;
  }> {
    this.#assertWorker(workerName);
    throw preflightError(
      "Wrangler OAuth cannot prove workers.dev enabled state; " +
        "use CLOUDFLARE_API_TOKEN and direct REST state",
    );
  }

  async workerAccountSubdomain(): Promise<string> {
    throw preflightError(
      "Wrangler OAuth cannot prove the authoritative account workers.dev subdomain; " +
        "use CLOUDFLARE_API_TOKEN and direct REST state",
    );
  }

  async #json(command: readonly string[], label: string): Promise<unknown> {
    let result: CommandResult;
    try {
      result = await this.#run(wranglerCommand(command), { env: this.#environment });
    } catch {
      throw preflightError(`${label} could not be started`);
    }
    if (result.exitCode !== 0) {
      // Wrangler diagnostics can include account- or credential-sensitive
      // details. Keep this reader's failure value-free and let --status settle
      // the state instead of replaying a command blindly.
      throw preflightError(`${label} failed (exit ${result.exitCode})`);
    }
    return parseWranglerJson(result.stdout, label);
  }

  #assertWorker(workerName: string): void {
    if (workerName !== this.#workerName) {
      throw preflightError("Wrangler Worker state was asked for an unexpected Worker");
    }
  }
}

/** Parse one clean Wrangler --json response and reject any framing/noise. */
export function parseWranglerJson(raw: string, label = "Wrangler JSON response"): unknown {
  const text = raw.trim();
  if (text.length === 0) throw preflightError(`${label} is empty`);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw preflightError(`${label} is not exactly one JSON value`);
  }
}

export function parseWranglerDeploymentOutput(raw: string, workerName: string): readonly unknown[] {
  return parseWranglerDeploymentOutputValue(
    parseWranglerJson(raw, `${workerName} deployments list`),
    workerName,
  );
}

function parseWranglerDeploymentOutputValue(
  value: unknown,
  workerName: string,
): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw preflightError(`${workerName} Wrangler deployment history is not a JSON array`);
  }
  try {
    parseWorkerDeploymentChain(value, "preflight");
  } catch {
    throw preflightError(`${workerName} Wrangler deployment history has an invalid shape`);
  }
  return value;
}

export function parseWranglerVersionOutput(
  raw: string,
  versionId: string,
): Record<string, unknown> {
  return parseWranglerVersionOutputValue(
    parseWranglerJson(raw, `Wrangler Version ${versionId}`),
    versionId,
  );
}

function parseWranglerVersionOutputValue(
  value: unknown,
  versionId: string,
): Record<string, unknown> {
  if (!isRecord(value) || value.id !== versionId) {
    throw preflightError(`Wrangler Version response has a mismatched version id`);
  }
  return value;
}

export function parseWranglerSecretOutput(raw: string): readonly unknown[] {
  return parseWranglerSecretOutputValue(parseWranglerJson(raw, "Wrangler secret inventory"));
}

function parseWranglerSecretOutputValue(value: unknown): readonly unknown[] {
  if (!Array.isArray(value)) throw preflightError("Wrangler secret inventory is not a JSON array");
  try {
    parseWorkerSecretInventory(value, "preflight");
  } catch {
    throw preflightError("Wrangler secret inventory has an invalid shape");
  }
  return value;
}

export interface WranglerVersionPublication {
  readonly versionId: string;
  readonly deploymentId: string;
}

export interface WranglerExistingVersionDeployment {
  readonly versionId: string;
  readonly deploymentId: string;
}

export interface WranglerLifecycleDeployment {
  readonly versionId: string;
  readonly targets: readonly string[];
}

export interface WranglerVersionPublicationLease {
  readonly accountId: string;
  readonly workerName: string;
  release(): Promise<void>;
}

export interface WranglerVersionPublicationLeaseStatus {
  readonly state: "available" | "active" | "stale-reclaimable" | "unsafe";
  readonly reason:
    | "no-lock-file"
    | "kernel-lock-available"
    | "kernel-lock-held"
    | "stale-owner-record"
    | "owner-record-inconsistent";
}

interface WranglerVersionPublicationLeaseOwner {
  readonly kind: typeof LEASE_OWNER_KIND;
  readonly ownerId: string;
  readonly accountId: string;
  readonly workerName: string;
  readonly bootId: string;
  readonly holderPid: number;
  readonly holderStartTicks: string;
  readonly lockDevice: string;
  readonly lockInode: string;
  readonly createdAt: string;
}

/**
 * Serializes this owning publication path on one operator host. Cloudflare's
 * supported deployment POST has no predecessor/CAS input, so this deliberately
 * bounded lease prevents same-host entrypoint overlap without pretending to
 * fence the dashboard, direct API calls, or another host. Kernel flock is the
 * exclusion authority. The sidecar only supplies exact boot/PID-start/inode
 * evidence so status and the next apply can distinguish a crashed stale owner
 * from an active holder or an unsafe malformed record.
 */
export async function acquireWranglerVersionPublicationLease(input: {
  readonly accountId: string;
  readonly workerName: string;
  readonly root?: string;
}): Promise<WranglerVersionPublicationLease> {
  if (!ACCOUNT_ID.test(input.accountId) || !WORKER_NAME.test(input.workerName)) {
    throw preflightError("Worker Version publication lease requires one exact target");
  }
  const paths = publicationLeasePaths(input);
  ensurePrivateLeaseRoot(paths.root);
  ensurePrivateLeaseFile(paths.lockPath);
  const holder = Bun.spawn(
    [
      "flock",
      "--exclusive",
      "--nonblock",
      "--no-fork",
      paths.lockPath,
      "/bin/sh",
      "-c",
      'printf "takoserver-lease-held\\n"; exec cat',
    ],
    { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
  );
  const reader = holder.stdout.getReader();
  const handshake = await reader.read();
  reader.releaseLock();
  const handshakeText = handshake.done
    ? ""
    : new TextDecoder().decode(handshake.value, { stream: false });
  if (handshakeText !== "takoserver-lease-held\n") {
    const exitCode = await holder.exited;
    if (exitCode === 1) {
      throw preflightError(
        "another same-host Worker Version publication holds the active kernel lease",
        paths.lockPath,
      );
    }
    throw preflightError("Worker Version publication kernel lease could not be acquired");
  }

  let owner: WranglerVersionPublicationLeaseOwner;
  try {
    const lockIdentity = privateLeaseFileIdentity(paths.lockPath);
    const previousOwner = readLeaseOwner(paths.ownerPath, lockIdentity, input);
    if (previousOwner.kind === "unsafe") {
      throw preflightError(
        "Worker Version publication owner record is unsafe and cannot be reclaimed automatically",
        paths.ownerPath,
      );
    }
    if (
      previousOwner.kind === "owner" &&
      leaseOwnerProcessState(previousOwner.value) === "active"
    ) {
      throw preflightError(
        "Worker Version publication owner record conflicts with the available kernel lease",
        paths.ownerPath,
      );
    }
    const holderStartTicks = procProcessStartTicks(holder.pid);
    if (holderStartTicks === null) {
      throw preflightError(
        "Worker Version publication kernel lease holder identity is unavailable",
      );
    }
    owner = {
      kind: LEASE_OWNER_KIND,
      ownerId: randomUUID(),
      accountId: input.accountId,
      workerName: input.workerName,
      bootId: hostBootId(),
      holderPid: holder.pid,
      holderStartTicks,
      lockDevice: lockIdentity.device,
      lockInode: lockIdentity.inode,
      createdAt: new Date().toISOString(),
    };
    writeLeaseOwner(paths, owner);
  } catch (error) {
    await stopLeaseHolder(holder);
    if (error instanceof DeployError) throw error;
    throw preflightError("Worker Version publication lease owner could not be recorded");
  }
  let released = false;
  return {
    accountId: input.accountId,
    workerName: input.workerName,
    async release() {
      if (released) return;
      released = true;
      try {
        const currentIdentity = privateLeaseFileIdentity(paths.lockPath);
        const current = readLeaseOwner(paths.ownerPath, currentIdentity, input);
        if (current.kind === "owner" && current.value.ownerId === owner.ownerId) {
          unlinkSync(paths.ownerPath);
          fsyncDirectory(paths.root);
        }
      } catch {
        // A missing or replaced owner is never removed on assumption. The
        // kernel lease is still released, and a complete retained record is
        // classified on the next status/apply.
      }
      await stopLeaseHolder(holder);
    },
  };
}

export function inspectWranglerVersionPublicationLease(input: {
  readonly accountId: string;
  readonly workerName: string;
  readonly root?: string;
}): WranglerVersionPublicationLeaseStatus {
  if (!ACCOUNT_ID.test(input.accountId) || !WORKER_NAME.test(input.workerName)) {
    throw preflightError("Worker Version publication lease status requires one exact target");
  }
  const paths = publicationLeasePaths(input);
  if (!pathEntryExists(paths.lockPath)) {
    return pathEntryExists(paths.ownerPath)
      ? { state: "unsafe", reason: "owner-record-inconsistent" }
      : { state: "available", reason: "no-lock-file" };
  }
  let identity: { readonly device: string; readonly inode: string };
  try {
    ensurePrivateLeaseRoot(paths.root, false);
    identity = privateLeaseFileIdentity(paths.lockPath);
  } catch {
    return { state: "unsafe", reason: "owner-record-inconsistent" };
  }
  const probe = Bun.spawnSync(["flock", "--exclusive", "--nonblock", paths.lockPath, "/bin/true"], {
    stdout: "ignore",
    stderr: "ignore",
  });
  if (probe.exitCode === 1) {
    return { state: "active", reason: "kernel-lock-held" };
  }
  if (probe.exitCode !== 0) {
    return { state: "unsafe", reason: "owner-record-inconsistent" };
  }
  const owner = readLeaseOwner(paths.ownerPath, identity, input);
  if (owner.kind === "none") {
    return { state: "available", reason: "kernel-lock-available" };
  }
  if (owner.kind === "unsafe") {
    return { state: "unsafe", reason: "owner-record-inconsistent" };
  }
  try {
    if (leaseOwnerProcessState(owner.value) === "active") {
      return { state: "unsafe", reason: "owner-record-inconsistent" };
    }
  } catch {
    return { state: "unsafe", reason: "owner-record-inconsistent" };
  }
  return { state: "stale-reclaimable", reason: "stale-owner-record" };
}

function pathEntryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    throw error;
  }
}

function publicationLeasePaths(input: {
  readonly accountId: string;
  readonly workerName: string;
  readonly root?: string;
}): { readonly root: string; readonly lockPath: string; readonly ownerPath: string } {
  const root = input.root ?? join(tmpdir(), "takoserver-worker-publication-locks");
  if (!isAbsolute(root)) {
    throw preflightError("Worker Version publication lease root must be absolute");
  }
  const targetDigest = createHash("sha256")
    .update(`${input.accountId}\0${input.workerName}`)
    .digest("hex");
  return {
    root,
    lockPath: join(root, targetDigest),
    ownerPath: join(root, `${targetDigest}.owner.json`),
  };
}

function ensurePrivateLeaseRoot(root: string, create = true): void {
  if (create) mkdirSync(root, { recursive: true, mode: 0o700 });
  const rootState = lstatSync(root);
  const effectiveUserId = process.getuid?.();
  if (
    !rootState.isDirectory() ||
    rootState.isSymbolicLink() ||
    (rootState.mode & 0o077) !== 0 ||
    (effectiveUserId !== undefined && rootState.uid !== effectiveUserId)
  ) {
    throw preflightError("Worker Version publication lease root is not private and owned");
  }
}

function ensurePrivateLeaseFile(path: string): void {
  let descriptor: number;
  try {
    descriptor = openSync(
      path,
      constants.O_CREAT | constants.O_APPEND | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
  } catch {
    throw preflightError("Worker Version publication kernel lease file could not be opened safely");
  }
  closeSync(descriptor);
  privateLeaseFileIdentity(path);
}

function privateLeaseFileIdentity(path: string): {
  readonly device: string;
  readonly inode: string;
} {
  const state = lstatSync(path, { bigint: true });
  const effectiveUserId = process.getuid?.();
  if (
    !state.isFile() ||
    state.isSymbolicLink() ||
    state.nlink !== 1n ||
    (state.mode & 0o077n) !== 0n ||
    (effectiveUserId !== undefined && state.uid !== BigInt(effectiveUserId))
  ) {
    throw preflightError("Worker Version publication kernel lease file is not private and owned");
  }
  return { device: String(state.dev), inode: String(state.ino) };
}

function readLeaseOwner(
  ownerPath: string,
  lockIdentity: { readonly device: string; readonly inode: string },
  target: { readonly accountId: string; readonly workerName: string },
):
  | { readonly kind: "none" }
  | { readonly kind: "unsafe" }
  | { readonly kind: "owner"; readonly value: WranglerVersionPublicationLeaseOwner } {
  if (!existsSync(ownerPath)) return { kind: "none" };
  try {
    const state = lstatSync(ownerPath, { bigint: true });
    const effectiveUserId = process.getuid?.();
    if (
      !state.isFile() ||
      state.isSymbolicLink() ||
      state.nlink !== 1n ||
      state.size < 1n ||
      state.size > BigInt(MAX_LEASE_OWNER_BYTES) ||
      (state.mode & 0o077n) !== 0n ||
      (effectiveUserId !== undefined && state.uid !== BigInt(effectiveUserId))
    ) {
      return { kind: "unsafe" };
    }
    const parsed = JSON.parse(readFileSync(ownerPath, "utf8")) as unknown;
    if (!isRecord(parsed)) return { kind: "unsafe" };
    const keys = Object.keys(parsed).sort();
    const expectedKeys = [
      "accountId",
      "bootId",
      "createdAt",
      "holderPid",
      "holderStartTicks",
      "kind",
      "lockDevice",
      "lockInode",
      "ownerId",
      "workerName",
    ];
    if (JSON.stringify(keys) !== JSON.stringify(expectedKeys)) return { kind: "unsafe" };
    if (
      parsed.kind !== LEASE_OWNER_KIND ||
      typeof parsed.ownerId !== "string" ||
      !UUID.test(parsed.ownerId) ||
      parsed.accountId !== target.accountId ||
      parsed.workerName !== target.workerName ||
      typeof parsed.bootId !== "string" ||
      !BOOT_ID.test(parsed.bootId) ||
      typeof parsed.holderPid !== "number" ||
      !Number.isSafeInteger(parsed.holderPid) ||
      parsed.holderPid < 1 ||
      typeof parsed.holderStartTicks !== "string" ||
      !PROCESS_START_TICKS.test(parsed.holderStartTicks) ||
      parsed.lockDevice !== lockIdentity.device ||
      parsed.lockInode !== lockIdentity.inode ||
      typeof parsed.createdAt !== "string" ||
      new Date(parsed.createdAt).toISOString() !== parsed.createdAt
    ) {
      return { kind: "unsafe" };
    }
    return { kind: "owner", value: parsed as unknown as WranglerVersionPublicationLeaseOwner };
  } catch {
    return { kind: "unsafe" };
  }
}

function writeLeaseOwner(
  paths: { readonly root: string; readonly ownerPath: string },
  owner: WranglerVersionPublicationLeaseOwner,
): void {
  const temporaryPath = `${paths.ownerPath}.${owner.ownerId}.tmp`;
  let descriptor: number | null = null;
  try {
    descriptor = openSync(
      temporaryPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    writeFileSync(descriptor, `${JSON.stringify(owner)}\n`, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
    renameSync(temporaryPath, paths.ownerPath);
    fsyncDirectory(paths.root);
  } catch (error) {
    if (descriptor !== null) closeSync(descriptor);
    rmSync(temporaryPath, { force: true });
    throw error;
  }
}

function fsyncDirectory(path: string): void {
  const descriptor = openSync(path, constants.O_RDONLY);
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function hostBootId(): string {
  const value = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  if (!BOOT_ID.test(value)) {
    throw preflightError("Worker Version publication host boot identity is unavailable");
  }
  return value;
}

function procProcessStartTicks(pid: number): string | null {
  let value: string;
  try {
    value = readFileSync(`/proc/${pid}/stat`, "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT" || errorCode(error) === "ESRCH") return null;
    throw preflightError("Worker Version publication process identity could not be read");
  }
  const commandEnd = value.lastIndexOf(")");
  const fields =
    commandEnd < 0
      ? []
      : value
          .slice(commandEnd + 2)
          .trim()
          .split(/\s+/u);
  const startTicks = fields[19];
  if (startTicks === undefined || !PROCESS_START_TICKS.test(startTicks)) {
    throw preflightError("Worker Version publication process identity is malformed");
  }
  return startTicks;
}

function leaseOwnerProcessState(owner: WranglerVersionPublicationLeaseOwner): "active" | "stale" {
  if (owner.bootId !== hostBootId()) return "stale";
  const currentStartTicks = procProcessStartTicks(owner.holderPid);
  return currentStartTicks === owner.holderStartTicks ? "active" : "stale";
}

async function stopLeaseHolder(holder: {
  readonly stdin: { end(): void };
  readonly exited: Promise<number>;
}): Promise<void> {
  try {
    holder.stdin.end();
  } catch {
    // Poll the child below even if its input already closed.
  }
  await holder.exited.catch(() => undefined);
}

/**
 * Uploads a version and then explicitly deploys exactly that version to 100%
 * traffic. The config is expected to be topology-neutral; neither command
 * invokes trigger/domain mutation. The caller authoritatively re-reads the
 * active predecessor after upload. Cloudflare exposes no conditional traffic
 * mutation, so that read is an observation rather than CAS; post-mutation
 * history must establish the actual predecessor.
 */
export async function publishWranglerVersion(input: {
  readonly root: string;
  readonly bundlePath: string;
  readonly configPath: string;
  readonly accountId: string;
  readonly workerName: string;
  readonly message: string;
  /** Caller-held target lease; the caller releases it only after authoritative verification. */
  readonly lease: WranglerVersionPublicationLease;
  /** Re-read and compare the pinned active deployment after upload, immediately before traffic. */
  readonly assertPredecessorStillCurrent: () => Promise<void>;
  /** Prove the exact staged immutable Version before any traffic deployment. */
  readonly assertUploadedVersion?: (versionId: string) => Promise<void>;
  readonly environment?: Readonly<Record<string, string>>;
  readonly run?: WranglerProcess;
}): Promise<WranglerVersionPublication> {
  if (!isAbsolute(input.root) || !isAbsolute(input.bundlePath) || !isAbsolute(input.configPath)) {
    throw preflightError("Wrangler version publication requires absolute artifact paths");
  }
  if (!WORKER_NAME.test(input.workerName)) {
    throw preflightError("Wrangler version publication requires one exact Worker name");
  }
  if (input.lease.accountId !== input.accountId || input.lease.workerName !== input.workerName) {
    throw preflightError("Wrangler version publication lease does not match the exact target");
  }
  const run = input.run ?? runCommand;
  return await publishWranglerVersionWhileLeased(input, run);
}

/**
 * Atomically uploads and deploys one Worker bundle that carries a Durable
 * Object lifecycle change. Cloudflare rejects lifecycle changes through
 * `versions upload`, so this deliberately cannot share the staged Version
 * path above. The caller owns provider-history readback because Wrangler's
 * deploy event identifies the Version but not its Deployment.
 */
export async function deployWranglerLifecycleChange(input: {
  readonly root: string;
  readonly bundlePath: string;
  readonly configPath: string;
  readonly accountId: string;
  readonly workerName: string;
  readonly message: string;
  readonly lease: WranglerVersionPublicationLease;
  readonly assertCurrentStillExpected: () => Promise<void>;
  /** Already-validated private JSON used by Wrangler's one-operation secret upload. */
  readonly secretsFilePath?: string;
  readonly environment?: Readonly<Record<string, string>>;
  readonly run?: WranglerProcess;
}): Promise<WranglerLifecycleDeployment> {
  if (
    !isAbsolute(input.root) ||
    !isAbsolute(input.bundlePath) ||
    !isAbsolute(input.configPath) ||
    (input.secretsFilePath !== undefined && !isAbsolute(input.secretsFilePath))
  ) {
    throw preflightError("Wrangler lifecycle deployment requires absolute artifact paths");
  }
  if (!WORKER_NAME.test(input.workerName)) {
    throw preflightError("Wrangler lifecycle deployment requires one exact Worker name");
  }
  if (input.lease.accountId !== input.accountId || input.lease.workerName !== input.workerName) {
    throw preflightError("Wrangler lifecycle deployment lease does not match the exact target");
  }
  try {
    await input.assertCurrentStillExpected();
  } catch (error) {
    throw mutationError(
      "Worker lifecycle predecessor re-fence failed; this invocation did not start a deployment",
      safeErrorDetail(error),
    );
  }
  mkdirSync(input.root, { recursive: true, mode: 0o700 });
  const outputPath = join(input.root, "wrangler-lifecycle-deploy.jsonl");
  rmSync(outputPath, { force: true });
  const deployed = await runPublicationCommand(
    input.run ?? runCommand,
    wranglerCommand([
      "deploy",
      input.bundlePath,
      "--name",
      input.workerName,
      "--no-bundle",
      "--config",
      input.configPath,
      "--strict",
      "--message",
      input.message,
      ...(input.secretsFilePath === undefined ? [] : ["--secrets-file", input.secretsFilePath]),
    ]),
    { ...(input.environment ?? {}), WRANGLER_OUTPUT_FILE_PATH: outputPath },
    "Worker lifecycle deployment could not be started; run --status before repair",
  );
  if (deployed.exitCode !== 0) {
    throw mutationError(
      "Worker lifecycle deployment acknowledgement is indeterminate; do not retry before --status",
      `exit=${deployed.exitCode}`,
    );
  }
  try {
    return parseWranglerLifecycleDeployOutput(
      readOutput(outputPath, deployed.stdout),
      input.workerName,
    );
  } catch (error) {
    throw mutationError(
      "Worker lifecycle deployment returned no exact Version identity; run --status before repair",
      safeErrorDetail(error),
    );
  }
}

async function publishWranglerVersionWhileLeased(
  input: {
    readonly root: string;
    readonly bundlePath: string;
    readonly configPath: string;
    readonly accountId: string;
    readonly workerName: string;
    readonly message: string;
    readonly lease: WranglerVersionPublicationLease;
    readonly assertPredecessorStillCurrent: () => Promise<void>;
    readonly assertUploadedVersion?: (versionId: string) => Promise<void>;
    readonly environment?: Readonly<Record<string, string>>;
  },
  run: WranglerProcess,
): Promise<WranglerVersionPublication> {
  mkdirSync(input.root, { recursive: true, mode: 0o700 });
  const uploadOutputPath = join(input.root, "wrangler-version-upload.jsonl");
  const deployOutputPath = join(input.root, "wrangler-version-deploy.jsonl");
  rmSync(uploadOutputPath, { force: true });
  rmSync(deployOutputPath, { force: true });
  const environment = input.environment ?? {};

  const upload = await runPublicationCommand(
    run,
    wranglerCommand([
      "versions",
      "upload",
      input.bundlePath,
      "--name",
      input.workerName,
      "--no-bundle",
      "--config",
      input.configPath,
      "--strict",
      "--message",
      input.message,
    ]),
    { ...environment, WRANGLER_OUTPUT_FILE_PATH: uploadOutputPath },
    "Worker Version upload could not be started; do not retry before --status",
  );
  if (upload.exitCode !== 0) {
    throw mutationError(
      "Worker Version upload acknowledgement is indeterminate; do not retry before --status",
      `exit=${upload.exitCode}`,
    );
  }
  let uploaded: { readonly versionId: string };
  try {
    uploaded = parseWranglerVersionUploadOutput(
      readOutput(uploadOutputPath, upload.stdout),
      input.workerName,
    );
  } catch (error) {
    throw mutationError(
      "Worker Version upload returned no exact publication identity; do not retry before --status",
      safeErrorDetail(error),
    );
  }

  if (input.assertUploadedVersion) {
    try {
      await input.assertUploadedVersion(uploaded.versionId);
    } catch (error) {
      throw mutationError(
        "staged Worker Version readback failed; this invocation did not start a traffic deployment",
        safeErrorDetail(error),
      );
    }
  }

  try {
    await input.assertPredecessorStillCurrent();
  } catch (error) {
    throw mutationError(
      "Worker predecessor re-fence failed after Version upload; traffic state is indeterminate, " +
        "and this invocation did not start a traffic deployment; run --status before repair",
      safeErrorDetail(error),
    );
  }

  const deployed = await runPublicationCommand(
    run,
    wranglerCommand([
      "versions",
      "deploy",
      `${uploaded.versionId}@100%`,
      "--name",
      input.workerName,
      "--config",
      input.configPath,
      "--yes",
      "--message",
      input.message,
    ]),
    { ...environment, WRANGLER_OUTPUT_FILE_PATH: deployOutputPath },
    "Worker Version deployment could not be started; run --status before repair",
  );
  if (deployed.exitCode !== 0) {
    throw mutationError(
      "Worker Version deployment acknowledgement is indeterminate; do not retry before --status",
      `exit=${deployed.exitCode}`,
    );
  }
  let deployment: { readonly deploymentId: string };
  try {
    deployment = parseWranglerVersionDeployOutput(
      readOutput(deployOutputPath, deployed.stdout),
      input.workerName,
      uploaded.versionId,
    );
  } catch (error) {
    throw mutationError(
      "Worker Version deployment returned no exact deployment identity; run --status before repair",
      safeErrorDetail(error),
    );
  }
  return { versionId: uploaded.versionId, deploymentId: deployment.deploymentId };
}

/** Deploy one provider-history predecessor without uploading or rebuilding it. */
export async function deployExistingWranglerVersion(input: {
  readonly root: string;
  readonly configPath: string;
  readonly accountId: string;
  readonly workerName: string;
  readonly versionId: string;
  readonly message: string;
  readonly lease: WranglerVersionPublicationLease;
  readonly assertCurrentStillExpected: () => Promise<void>;
  readonly environment?: Readonly<Record<string, string>>;
  readonly run?: WranglerProcess;
}): Promise<WranglerExistingVersionDeployment> {
  if (!isAbsolute(input.root) || !isAbsolute(input.configPath)) {
    throw preflightError("Wrangler existing Version deployment requires absolute paths");
  }
  if (!WORKER_NAME.test(input.workerName) || !UUID.test(input.versionId)) {
    throw preflightError("Wrangler existing Version deployment requires one exact target");
  }
  if (input.lease.accountId !== input.accountId || input.lease.workerName !== input.workerName) {
    throw preflightError("Wrangler existing Version deployment lease does not match the target");
  }
  try {
    await input.assertCurrentStillExpected();
  } catch (error) {
    throw mutationError(
      "Worker rollback predecessor re-fence failed; this invocation did not mutate traffic",
      safeErrorDetail(error),
    );
  }
  mkdirSync(input.root, { recursive: true, mode: 0o700 });
  const outputPath = join(input.root, "wrangler-existing-version-deploy.jsonl");
  rmSync(outputPath, { force: true });
  const deployed = await runPublicationCommand(
    input.run ?? runCommand,
    wranglerCommand([
      "versions",
      "deploy",
      `${input.versionId}@100%`,
      "--name",
      input.workerName,
      "--config",
      input.configPath,
      "--yes",
      "--message",
      input.message,
    ]),
    { ...(input.environment ?? {}), WRANGLER_OUTPUT_FILE_PATH: outputPath },
    "Worker rollback deployment could not be started; run --status before repair",
  );
  if (deployed.exitCode !== 0) {
    throw mutationError(
      "Worker rollback deployment acknowledgement is indeterminate; run --status before repair",
      `exit=${deployed.exitCode}`,
    );
  }
  let deployment: { readonly deploymentId: string };
  try {
    deployment = parseWranglerVersionDeployOutput(
      readOutput(outputPath, deployed.stdout),
      input.workerName,
      input.versionId,
    );
  } catch (error) {
    throw mutationError(
      "Worker rollback returned no exact deployment identity; run --status before repair",
      safeErrorDetail(error),
    );
  }
  return { versionId: input.versionId, deploymentId: deployment.deploymentId };
}

async function runPublicationCommand(
  run: WranglerProcess,
  command: readonly string[],
  environment: Readonly<Record<string, string>>,
  message: string,
): Promise<CommandResult> {
  try {
    return await run(command, { env: environment });
  } catch {
    throw mutationError(message, "process invocation failed");
  }
}

export function parseWranglerVersionUploadOutput(
  raw: string,
  workerName: string,
): { readonly versionId: string } {
  const event = parsePublicationEvent(raw, "version upload");
  assertExactEventKeys(event, "version upload", [
    "type",
    "version",
    "worker_name",
    "worker_tag",
    "version_id",
    "preview_url",
    "preview_alias_url",
    "worker_name_overridden",
    "wrangler_environment",
    "timestamp",
  ]);
  if (
    event.type !== "version-upload" ||
    event.version !== 1 ||
    event.worker_name !== workerName ||
    event.worker_name_overridden !== false ||
    typeof event.version_id !== "string" ||
    !UUID.test(event.version_id)
  ) {
    throw preflightError("Wrangler version upload event has an invalid publication shape");
  }
  assertOptionalNullableString(event.worker_tag, "worker_tag");
  assertOptionalNullableString(event.preview_url, "preview_url");
  assertOptionalNullableString(event.preview_alias_url, "preview_alias_url");
  assertOptionalString(event.wrangler_environment, "wrangler_environment");
  assertOptionalTimestamp(event.timestamp);
  return { versionId: event.version_id };
}

export function parseWranglerLifecycleDeployOutput(
  raw: string,
  workerName: string,
): WranglerLifecycleDeployment {
  const event = parsePublicationEvent(raw, "lifecycle deployment");
  assertExactEventKeys(event, "lifecycle deployment", [
    "type",
    "version",
    "worker_name",
    "worker_tag",
    "version_id",
    "targets",
    "worker_name_overridden",
    "wrangler_environment",
    "timestamp",
  ]);
  if (
    event.type !== "deploy" ||
    event.version !== 1 ||
    event.worker_name !== workerName ||
    event.worker_name_overridden !== false ||
    typeof event.version_id !== "string" ||
    !UUID.test(event.version_id) ||
    !Array.isArray(event.targets) ||
    event.targets.some((target) => typeof target !== "string")
  ) {
    throw preflightError("Wrangler lifecycle deployment event has an invalid publication shape");
  }
  assertOptionalNullableString(event.worker_tag, "worker_tag");
  assertOptionalString(event.wrangler_environment, "wrangler_environment");
  assertOptionalTimestamp(event.timestamp);
  return { versionId: event.version_id, targets: event.targets };
}

export function parseWranglerVersionDeployOutput(
  raw: string,
  workerName: string,
  expectedVersionId?: string,
): { readonly deploymentId: string } {
  const event = parsePublicationEvent(raw, "version deployment");
  assertExactEventKeys(event, "version deployment", [
    "type",
    "version",
    "worker_name",
    "worker_tag",
    "deployment_id",
    "version_traffic",
    "wrangler_environment",
    "timestamp",
  ]);
  if (
    event.type !== "version-deploy" ||
    event.version !== 1 ||
    event.worker_name !== workerName ||
    typeof event.deployment_id !== "string" ||
    !UUID.test(event.deployment_id)
  ) {
    throw preflightError("Wrangler version deployment event has an invalid publication shape");
  }
  assertOptionalNullableString(event.worker_tag, "worker_tag");
  if (!Object.hasOwn(event, "version_traffic") || !isRecord(event.version_traffic)) {
    throw preflightError("Wrangler version deployment event has an invalid traffic shape");
  }
  const traffic = event.version_traffic;
  for (const value of Object.values(traffic)) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100) {
      throw preflightError("Wrangler version deployment event has an invalid traffic shape");
    }
  }
  if (expectedVersionId !== undefined && Object.keys(traffic).length > 0) {
    const keys = Object.keys(traffic);
    if (keys.length !== 1 || keys[0] !== expectedVersionId || traffic[expectedVersionId] !== 100) {
      throw preflightError(
        "Wrangler version deployment event does not identify the uploaded Version at 100 percent",
      );
    }
  }
  assertOptionalString(event.wrangler_environment, "wrangler_environment");
  assertOptionalTimestamp(event.timestamp);
  return { deploymentId: event.deployment_id };
}

function parsePublicationEvent(raw: string, operation: string): Record<string, unknown> {
  const text = raw.trim();
  if (text.length === 0) throw preflightError(`Wrangler ${operation} returned no JSON event`);
  const lines = text.split(/\r?\n/u).filter((line) => line.trim().length > 0);
  if (lines.length !== 1) {
    throw preflightError(`Wrangler ${operation} must return exactly one JSON event`);
  }
  const parsed = parseWranglerJson(lines[0] as string, `Wrangler ${operation} event`);
  if (!isRecord(parsed)) throw preflightError(`Wrangler ${operation} event is not an object`);
  return parsed;
}

function assertExactEventKeys(
  event: Record<string, unknown>,
  operation: string,
  allowed: readonly string[],
): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(event).filter((key) => !allowedSet.has(key));
  if (unknown.length > 0) {
    throw preflightError(
      `Wrangler ${operation} event contains unexpected fields`,
      JSON.stringify(unknown.sort()),
    );
  }
}

function assertOptionalNullableString(value: unknown, field: string): void {
  if (value !== undefined && value !== null && typeof value !== "string") {
    throw preflightError(`Wrangler publication event field ${field} has an invalid shape`);
  }
}

function assertOptionalString(value: unknown, field: string): void {
  if (value !== undefined && typeof value !== "string") {
    throw preflightError(`Wrangler publication event field ${field} has an invalid shape`);
  }
}

function assertOptionalTimestamp(value: unknown): void {
  if (
    value !== undefined &&
    (typeof value !== "string" || !Number.isFinite(Date.parse(value)) || value.trim() !== value)
  ) {
    throw preflightError("Wrangler publication event timestamp has an invalid shape");
  }
}

function readOutput(path: string, stdout: string): string {
  if (existsSync(path)) {
    const value = readFileSync(path, "utf8");
    if (value.trim().length > 0) return value;
  }
  return stdout;
}

function safeErrorDetail(error: unknown): string | undefined {
  if (error instanceof DeployError) return error.message;
  return "invalid Wrangler publication event";
}

function errorCode(error: unknown): string | undefined {
  return isRecord(error) && typeof error.code === "string" ? error.code : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
