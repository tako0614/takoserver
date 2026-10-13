import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { CloudflareState } from "./cloudflare-state.ts";
import { DeployError, mutationError, preflightError, verificationError } from "./errors.ts";
import {
  type CommandResult,
  resolveCloudflareCredential,
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

/** The production (and rehearsal) Console Worker, served on its custom domain. */
export const CONSOLE_WORKER = "takoserver-console";

/**
 * An integration Console is its own Worker on its own account-owned
 * workers.dev origin. Integration shares the Cloudflare account with
 * production, so the Worker name comes from the target's consoleOrigin and
 * can never be the production Console's, and no custom domain is read or
 * written for it.
 */
const INTEGRATION_CONSOLE_WORKER = /^takoserver-console-[a-z0-9](?:[a-z0-9-]{0,40}[a-z0-9])?$/u;
const WORKERS_DEV_HOSTNAME =
  /^([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)\.([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)\.workers\.dev$/u;

/** Where the selected environment's Console lives. */
export type ConsolePlacement =
  | {
      readonly topology: "custom-domain";
      readonly workerName: typeof CONSOLE_WORKER;
      readonly hostname: string;
    }
  | {
      readonly topology: "workers-dev";
      readonly workerName: string;
      readonly hostname: string;
      readonly accountSubdomain: string;
    };

/**
 * Derives the Console Worker and origin for an environment. Production and
 * rehearsal keep the one custom-domain Console. Integration must name a
 * `takoserver-console-<label>` Worker on `https://<worker>.<account>.workers.dev`
 * and is refused otherwise, before any provider read.
 */
export function consolePlacement(
  target: Pick<DeployTarget, "consoleOrigin" | "workerName">,
  environment: DeployEnvironment,
): ConsolePlacement {
  if (!target.consoleOrigin) throw preflightError("selected target has no consoleOrigin");
  const origin = new URL(target.consoleOrigin);
  if (environment === "production" || environment === "rehearsal") {
    return { topology: "custom-domain", workerName: CONSOLE_WORKER, hostname: origin.hostname };
  }
  if (environment !== "integration") {
    throw preflightError("the Console surface has no placement for this environment");
  }
  const match = WORKERS_DEV_HOSTNAME.exec(origin.hostname);
  if (
    origin.protocol !== "https:" ||
    origin.port !== "" ||
    origin.username !== "" ||
    origin.password !== "" ||
    origin.pathname !== "/" ||
    origin.search !== "" ||
    origin.hash !== "" ||
    match === null
  ) {
    throw preflightError(
      "an integration Console origin must be exactly https://<console worker>.<account subdomain>.workers.dev",
    );
  }
  const [, workerName, accountSubdomain] = match as unknown as [string, string, string];
  if (workerName === CONSOLE_WORKER || !INTEGRATION_CONSOLE_WORKER.test(workerName)) {
    throw preflightError(
      "an integration Console must be its own takoserver-console-<label> Worker, never the production Console",
    );
  }
  if (workerName === target.workerName) {
    throw preflightError("the integration Console Worker must differ from the API Worker");
  }
  return { topology: "workers-dev", workerName, hostname: origin.hostname, accountSubdomain };
}

export type ConsoleProcess = (
  command: readonly string[],
  options?: { readonly env?: Readonly<Record<string, string>>; readonly input?: string },
) => Promise<CommandResult>;

export interface ConsoleState {
  workerDomainOwner(hostname: string): Promise<string | null>;
  workerDeployments(workerName: string): Promise<readonly unknown[]>;
  workerVersion(workerName: string, versionId: string): Promise<unknown>;
  /** The account's `<subdomain>.workers.dev`, read for an integration Console. */
  workerAccountSubdomain(): Promise<string>;
  /** Whether a Worker is served on workers.dev, read after an integration upload. */
  workerSubdomain(
    workerName: string,
  ): Promise<{ readonly enabled: boolean; readonly previewsEnabled: boolean }>;
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
  if (target.environment !== invocation.environment) {
    throw preflightError("Console invocation and target environments differ");
  }
  // Decided before any credential or provider read: an integration target
  // that names the production Console, or any custom domain, stops here.
  const placement = consolePlacement(target, invocation.environment);
  const workerName = placement.workerName;
  const run = options.run ?? runCommand;
  const credential =
    invocation.environment === "integration" &&
    options.state !== undefined &&
    invocation.action === "status"
      ? undefined
      : await resolveCloudflareCredential(invocation.environment, {
          cloudflareEnvironment: options.cloudflareEnvironment,
          run,
        });
  const environment = credential?.childEnvironment ?? {};
  const state =
    options.state ??
    new CloudflareState({
      accountId: target.accountId,
      token: credential?.token ?? exactToken(environment),
    });
  let ownerBefore: string | null = null;
  if (placement.topology === "custom-domain") {
    ownerBefore = await state.workerDomainOwner(placement.hostname);
    if (ownerBefore !== CONSOLE_WORKER) {
      throw preflightError(
        `Console domain ${placement.hostname} is owned by ${JSON.stringify(ownerBefore)}, not ${CONSOLE_WORKER}`,
        "Domain attachment is a separate optional topology operation and this routine surface never performs it.",
      );
    }
  } else {
    await assertAccountSubdomain(state, placement.accountSubdomain);
  }
  const before = parseWorkerDeploymentHistory(await state.workerDeployments(workerName));
  const beforeVersion = before ? await state.workerVersion(workerName, before.versionId) : null;
  // An existing integration Worker of that name must already be a Console
  // this surface published; a foreign Worker is never adopted by name.
  if (
    placement.topology === "workers-dev" &&
    beforeVersion !== null &&
    versionCommit(beforeVersion, workerName) === null
  ) {
    throw preflightError(
      `Worker ${workerName} exists and is not a Console this surface published; it is never adopted`,
    );
  }
  if (invocation.action === "status") {
    // After an indeterminate upload the operator comes here: say whether the
    // integration Console is actually served, not only which commit it names.
    const served =
      placement.topology === "workers-dev" && before !== null
        ? await state.workerSubdomain(workerName)
        : null;
    return {
      kind: "takoserver.console-status@v2",
      surface: "takoserver-console",
      environment: invocation.environment,
      selectedCommit: invocation.commit,
      workerName,
      topology: placement.topology,
      origin: target.consoleOrigin,
      ...(placement.topology === "custom-domain" ? { domainOwner: ownerBefore } : {}),
      ...(placement.topology === "workers-dev"
        ? {
            workersDev:
              served === null
                ? null
                : { enabled: served.enabled, previewsEnabled: served.previewsEnabled },
          }
        : {}),
      deploymentId: before?.deploymentId ?? null,
      versionId: before?.versionId ?? null,
      previousVersionId: before?.previousVersionId ?? null,
      commitMatches:
        beforeVersion === null
          ? false
          : versionCommit(beforeVersion, workerName) === invocation.commit,
    };
  }
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
        `${workerName} ${source.commit}`,
      ]),
      { env: environment },
    );
    if (upload.exitCode !== 0) {
      throw mutationError(
        "Console upload acknowledgement is indeterminate; do not retry before --status",
        `${upload.stdout}${upload.stderr}`.trim(),
      );
    }
    // From here the upload was acknowledged: any failure, including a failed
    // provider read, is a verification failure of a published Console, never
    // a preflight "nothing was touched".
    let verified: {
      readonly ownerAfter: string | null;
      readonly after: NonNullable<ReturnType<typeof parseWorkerDeploymentHistory>>;
      readonly readback: Awaited<ReturnType<typeof readConsoleOnce>>;
    };
    try {
      verified = await (async () => {
        let ownerAfter: string | null = null;
        if (placement.topology === "custom-domain") {
          ownerAfter = await state.workerDomainOwner(placement.hostname);
          if (ownerAfter !== ownerBefore) {
            throw verificationError(
              `Console domain owner changed from ${ownerBefore} to ${JSON.stringify(ownerAfter)}`,
            );
          }
        } else {
          await assertAccountSubdomain(state, placement.accountSubdomain, "verification");
          const served = await state.workerSubdomain(workerName);
          if (!served.enabled || served.previewsEnabled) {
            throw verificationError(
              `integration Console ${workerName} is not served on workers.dev with previews disabled`,
            );
          }
        }
        const after = parseWorkerDeploymentHistory(await state.workerDeployments(workerName));
        if (!after || after.versionId === before?.versionId) {
          throw verificationError("Console authoritative history contains no new served version");
        }
        const version = await state.workerVersion(workerName, after.versionId);
        if (versionCommit(version, workerName) !== source.commit) {
          throw verificationError("Console served version does not name the selected commit");
        }
        const local = readFileSync(join(assets, "console.js"));
        const readback = await readConsoleOnce(
          `${target.consoleOrigin}/console.js`,
          local,
          options.fetcher ?? ((input, init) => fetch(input, init)),
        );
        return { ownerAfter, after, readback };
      })();
    } catch (error) {
      if (error instanceof DeployError && error.phase === "verification") throw error;
      throw verificationError(
        "Console post-upload verification failed after the upload was acknowledged; run --status",
        error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      );
    }
    const { ownerAfter, after, readback } = verified;
    return {
      kind: "takoserver.console-apply@v2",
      surface: "takoserver-console",
      environment: invocation.environment,
      commit: source.commit,
      workerName,
      topology: placement.topology,
      origin: target.consoleOrigin,
      artifactDigest: artifact.digest,
      artifactBytes: artifact.bytes,
      artifactFiles: artifact.files,
      previousVersionId: before?.versionId ?? null,
      deploymentId: after.deploymentId,
      versionId: after.versionId,
      ...(placement.topology === "custom-domain" ? { domainOwner: ownerAfter } : {}),
      readback,
      rollback: before
        ? `wrangler rollback ${before.versionId} --name ${workerName} --yes --message "rollback ${source.commit}"`
        : placement.topology === "workers-dev"
          ? `no previous Console version; to remove this first integration Console: wrangler delete --name ${workerName} (never the production Console)`
          : "forward repair only: no previous Console version exists",
    };
  } finally {
    unsealDirectory(root);
    if (temporary) rmSync(root, { recursive: true, force: true });
  }
}

/** The integration Console origin must be on this account's own workers.dev subdomain. */
async function assertAccountSubdomain(
  state: ConsoleState,
  expected: string,
  phase: "preflight" | "verification" = "preflight",
): Promise<void> {
  const actual = await state.workerAccountSubdomain();
  if (actual !== expected) {
    const message = `integration Console origin is not on this account's workers.dev subdomain (${JSON.stringify(actual)})`;
    throw phase === "preflight" ? preflightError(message) : verificationError(message);
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
  const placement = consolePlacement(target, target.environment);
  writeFileSync(
    input.path,
    `${JSON.stringify(
      {
        account_id: target.accountId,
        name: placement.workerName,
        compatibility_date: "2026-08-20",
        // Integration is served only on its own workers.dev origin; production
        // and rehearsal only on the custom domain their owner already holds.
        workers_dev: placement.topology === "workers-dev",
        ...(placement.topology === "workers-dev" ? { preview_urls: false } : {}),
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

function versionCommit(value: unknown, workerName: string): string | null {
  if (!isRecord(value) || !isRecord(value.annotations)) {
    throw preflightError("Console version detail has no canonical annotations");
  }
  const message = value.annotations["workers/message"];
  if (typeof message !== "string" || !message.startsWith(`${workerName} `)) return null;
  const commit = message.slice(workerName.length + 1);
  return /^[0-9a-f]{40}$/u.test(commit) ? commit : null;
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
