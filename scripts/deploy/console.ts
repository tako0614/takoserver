import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { CloudflareState } from "./cloudflare-state.ts";
import { mutationError, preflightError, verificationError } from "./errors.ts";
import {
  type CommandResult,
  cloudflareChildEnvironment,
  runChecked,
  runCommand,
  wranglerCommand,
} from "./process.ts";
import {
  type DeployEnvironment,
  qualifySource,
  sealDirectory,
  unsealDirectory,
} from "./qualification.ts";
import type { DeployTarget } from "./target.ts";
import { parseWorkerDeploymentHistory } from "./worker-state.ts";

export const CONSOLE_WORKER = "takoserver-console";

export type ConsoleProcess = (
  command: readonly string[],
  options?: { readonly env?: Readonly<Record<string, string>>; readonly input?: string },
) => Promise<CommandResult>;

export interface ConsoleState {
  workerDomainOwner(hostname: string): Promise<string | null>;
  workerDeployments(workerName: string): Promise<readonly unknown[]>;
  workerVersion(workerName: string, versionId: string): Promise<unknown>;
}

export interface ConsoleInvocation {
  readonly action: "status" | "apply";
  readonly environment: DeployEnvironment;
  readonly commit: string;
}

export interface ConsoleOptions {
  readonly run?: ConsoleProcess;
  readonly state?: ConsoleState;
  readonly outputDirectory?: string;
  readonly fetcher?: (input: string, init?: RequestInit) => Promise<Response>;
  readonly cloudflareEnvironment?: Readonly<Record<string, string>>;
}

/** Routine Console status/upload. Domain attachment is deliberately absent. */
export async function runConsole(
  invocation: ConsoleInvocation,
  target: DeployTarget,
  options: ConsoleOptions = {},
): Promise<Record<string, unknown>> {
  if (!target.consoleOrigin) throw preflightError("selected target has no consoleOrigin");
  const hostname = new URL(target.consoleOrigin).hostname;
  const environment =
    options.cloudflareEnvironment ??
    (options.state !== undefined && invocation.action === "status"
      ? {}
      : cloudflareChildEnvironment());
  const state =
    options.state ??
    new CloudflareState({
      accountId: target.accountId,
      token: exactToken(environment),
    });
  const ownerBefore = await state.workerDomainOwner(hostname);
  if (ownerBefore !== CONSOLE_WORKER) {
    throw preflightError(
      `Console domain ${hostname} is owned by ${JSON.stringify(ownerBefore)}, not ${CONSOLE_WORKER}`,
      "Domain attachment is a separate optional topology operation and this routine surface never performs it.",
    );
  }
  const before = parseWorkerDeploymentHistory(await state.workerDeployments(CONSOLE_WORKER));
  if (invocation.action === "status") {
    const version = before ? await state.workerVersion(CONSOLE_WORKER, before.versionId) : null;
    return {
      kind: "takoserver.console-status@v2",
      surface: "takoserver-console",
      environment: invocation.environment,
      selectedCommit: invocation.commit,
      domainOwner: ownerBefore,
      deploymentId: before?.deploymentId ?? null,
      versionId: before?.versionId ?? null,
      previousVersionId: before?.previousVersionId ?? null,
      commitMatches: version === null ? false : versionCommit(version) === invocation.commit,
    };
  }

  const run = options.run ?? runCommand;
  const source = await qualifySource({
    environment: invocation.environment,
    commit: invocation.commit,
    run,
  });
  const temporary = options.outputDirectory === undefined;
  const root = options.outputDirectory ?? mkdtempSync(join(tmpdir(), "takoserver-console-"));
  const assets = join(root, "assets");
  mkdirSync(assets, { recursive: true, mode: 0o700 });
  try {
    await checked(run, "scoped Console build", [
      "bun",
      "scripts/build-console.ts",
      "--out",
      assets,
      "--api-origin",
      target.publicOrigin,
    ]);
    const configPath = writeConsoleConfig(target, {
      path: join(root, "wrangler.jsonc"),
      assets,
      commit: source.commit,
    });
    const artifact = sealDirectory(root, [
      "assets/console.js",
      "assets/index.html",
      "wrangler.jsonc",
    ]);
    artifact.assertUnchanged();
    const upload = await run(
      wranglerCommand([
        "deploy",
        "--config",
        configPath,
        "--strict",
        "--message",
        `${CONSOLE_WORKER} ${source.commit}`,
      ]),
      { env: environment },
    );
    if (upload.exitCode !== 0) {
      throw mutationError(
        "Console upload acknowledgement is indeterminate; do not retry before --status",
        `${upload.stdout}${upload.stderr}`.trim(),
      );
    }
    const ownerAfter = await state.workerDomainOwner(hostname);
    if (ownerAfter !== ownerBefore) {
      throw verificationError(
        `Console domain owner changed from ${ownerBefore} to ${JSON.stringify(ownerAfter)}`,
      );
    }
    const after = parseWorkerDeploymentHistory(await state.workerDeployments(CONSOLE_WORKER));
    if (!after || after.versionId === before?.versionId) {
      throw verificationError("Console authoritative history contains no new served version");
    }
    const version = await state.workerVersion(CONSOLE_WORKER, after.versionId);
    if (versionCommit(version) !== source.commit) {
      throw verificationError("Console served version does not name the selected commit");
    }
    const local = readFileSync(join(assets, "console.js"));
    const readback = await readConsoleOnce(
      `${target.consoleOrigin}/console.js`,
      local,
      options.fetcher ?? ((input, init) => fetch(input, init)),
    );
    return {
      kind: "takoserver.console-apply@v2",
      surface: "takoserver-console",
      environment: invocation.environment,
      commit: source.commit,
      artifactDigest: artifact.digest,
      artifactBytes: artifact.bytes,
      artifactFiles: artifact.files,
      previousVersionId: before?.versionId ?? null,
      deploymentId: after.deploymentId,
      versionId: after.versionId,
      domainOwner: ownerAfter,
      readback,
      rollback: before
        ? `wrangler rollback ${before.versionId} --name ${CONSOLE_WORKER} --yes --message "rollback ${source.commit}"`
        : "forward repair only: no previous Console version exists",
    };
  } finally {
    unsealDirectory(root);
    if (temporary) rmSync(root, { recursive: true, force: true });
  }
}

export function writeConsoleConfig(
  target: DeployTarget,
  input: { readonly path: string; readonly assets: string; readonly commit: string },
): string {
  if (!/^[0-9a-f]{40}$/u.test(input.commit)) {
    throw preflightError("Console config requires one exact commit");
  }
  if (resolve(dirname(input.path), "assets") !== resolve(input.assets)) {
    throw preflightError("Console assets must stay beside the sealed upload config");
  }
  writeFileSync(
    input.path,
    `${JSON.stringify(
      {
        account_id: target.accountId,
        name: CONSOLE_WORKER,
        compatibility_date: "2026-08-20",
        workers_dev: false,
        assets: {
          directory: "assets",
          not_found_handling: "single-page-application",
        },
        observability: { enabled: true },
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  return input.path;
}

async function checked(
  run: ConsoleProcess,
  description: string,
  command: readonly string[],
): Promise<string> {
  if (run === runCommand) return await runChecked("preflight", description, command);
  const result = await run(command);
  if (result.exitCode !== 0) {
    throw preflightError(
      `${description} failed (exit ${result.exitCode})`,
      `${result.stdout}${result.stderr}`.trim(),
    );
  }
  return result.stdout;
}

function versionCommit(value: unknown): string | null {
  if (!isRecord(value) || !isRecord(value.annotations)) {
    throw preflightError("Console version detail has no canonical annotations");
  }
  const message = value.annotations["workers/message"];
  if (typeof message !== "string") return null;
  const match = /^takoserver-console ([0-9a-f]{40})$/u.exec(message);
  return match?.[1] ?? null;
}

async function readConsoleOnce(
  url: string,
  expected: Uint8Array,
  fetcher: (input: string, init?: RequestInit) => Promise<Response>,
): Promise<{ readonly url: string; readonly digest: string; readonly bytes: number }> {
  let response: Response;
  try {
    response = await fetcher(url, {
      method: "GET",
      headers: { "cache-control": "no-cache" },
      redirect: "error",
    });
  } catch (error) {
    throw verificationError(
      "Console public readback failed",
      error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    );
  }
  const body = new Uint8Array(await response.arrayBuffer());
  const digest = sha256(body);
  if (
    response.status !== 200 ||
    digest !== sha256(expected) ||
    body.byteLength !== expected.byteLength
  ) {
    throw verificationError(
      "Console public bytes differ from the sealed artifact",
      `status=${response.status} digest=${digest} bytes=${body.byteLength}`,
    );
  }
  return { url, digest, bytes: body.byteLength };
}

function exactToken(environment: Readonly<Record<string, string>>): string {
  const value = environment.CLOUDFLARE_API_TOKEN;
  if (!value) throw preflightError("CLOUDFLARE_API_TOKEN is required");
  return value;
}

function sha256(value: Uint8Array): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
