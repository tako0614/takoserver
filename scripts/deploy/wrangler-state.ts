import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { DeployError, mutationError, preflightError } from "./errors.ts";
import { type CommandResult, runCommand, wranglerCommand } from "./process.ts";
import type { WorkerState } from "./worker-live.ts";
import { parseWorkerDeploymentChain, parseWorkerSecretInventory } from "./worker-state.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const WORKER_NAME = /^[a-z0-9][a-z0-9-]{1,62}$/u;

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

/**
 * Uploads a version and then explicitly deploys exactly that version to 100%
 * traffic. The config is expected to be topology-neutral; neither command
 * invokes trigger/domain mutation. The caller must authoritatively re-fence
 * the active predecessor after upload; traffic deployment never follows a
 * stale predecessor observation.
 */
export async function publishWranglerVersion(input: {
  readonly root: string;
  readonly bundlePath: string;
  readonly configPath: string;
  readonly workerName: string;
  readonly message: string;
  /** Re-read and compare the pinned active deployment after upload, immediately before traffic. */
  readonly assertPredecessorStillCurrent: () => Promise<void>;
  readonly environment?: Readonly<Record<string, string>>;
  readonly run?: WranglerProcess;
}): Promise<WranglerVersionPublication> {
  if (!isAbsolute(input.root) || !isAbsolute(input.bundlePath) || !isAbsolute(input.configPath)) {
    throw preflightError("Wrangler version publication requires absolute artifact paths");
  }
  if (!WORKER_NAME.test(input.workerName)) {
    throw preflightError("Wrangler version publication requires one exact Worker name");
  }
  const run = input.run ?? runCommand;
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

  try {
    await input.assertPredecessorStillCurrent();
  } catch (error) {
    throw mutationError(
      "Worker predecessor re-fence failed after Version upload; the uploaded Version is inactive and traffic was not changed",
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
