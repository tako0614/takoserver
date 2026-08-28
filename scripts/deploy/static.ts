import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CloudflareState } from "./cloudflare-state.ts";
import { DeployError, mutationError, preflightError, verificationError } from "./errors.ts";
import {
  type CommandResult,
  cloudflareChildEnvironment,
  runCommand,
  wranglerCommand,
} from "./process.ts";
import {
  type DeployEnvironment,
  qualifySource,
  type SourceQualification,
  sealDirectory,
} from "./qualification.ts";

export const PAGES_PROJECT = "takoserver-website";
export const SITE_ORIGIN = "https://takoserver.com";
export const CONSOLE_ORIGIN = "https://console.takoserver.com";
export const API_ORIGIN = "https://api.takoserver.com";

export type StaticProcess = (
  command: readonly string[],
  options?: { readonly env?: Readonly<Record<string, string>>; readonly input?: string },
) => Promise<CommandResult>;

export type StaticFetcher = (input: string, init?: RequestInit) => Promise<Response>;

export interface SiteState {
  pagesDeployments(project: string): Promise<readonly unknown[]>;
}

export interface StaticSiteInvocation {
  readonly action: "status" | "apply";
  readonly environment: DeployEnvironment;
  readonly commit: string;
}

export interface StaticSiteOptions {
  readonly run?: StaticProcess;
  readonly fetcher?: StaticFetcher;
  readonly outputDirectory?: string;
  readonly state?: SiteState;
  readonly accountId?: string;
  readonly cloudflareEnvironment?: Readonly<Record<string, string>>;
}

interface PagesDeployment {
  readonly id: string;
  readonly url: string;
  readonly commit: string | null;
  readonly createdOn: string;
  readonly environment: "production" | "preview";
  readonly successful: boolean;
}

/** One routine Pages status or direct upload. There is no plan/review/record path. */
export async function runStaticSite(
  invocation: StaticSiteInvocation,
  options: StaticSiteOptions = {},
): Promise<Record<string, unknown>> {
  const environment =
    options.cloudflareEnvironment ??
    (options.state !== undefined && invocation.action === "status"
      ? {}
      : cloudflareChildEnvironment());
  const state =
    options.state ??
    new CloudflareState({
      accountId: exactAccount(options.accountId),
      token: exactToken(environment),
    });
  const lane = invocation.environment === "production" ? "production" : "preview";
  const before = pagesHistory(await state.pagesDeployments(PAGES_PROJECT)).filter(
    (deployment) => deployment.environment === lane && deployment.successful,
  );
  const previous = before[0] ?? null;
  if (invocation.action === "status") {
    return {
      kind: "takoserver.site-status@v2",
      surface: "takoserver-site",
      environment: invocation.environment,
      selectedCommit: invocation.commit,
      project: PAGES_PROJECT,
      currentDeploymentId: previous?.id ?? null,
      currentUrl: previous?.url ?? null,
      currentCommit: previous?.commit ?? null,
      commitMatches: previous?.commit === invocation.commit,
      rollbackDeploymentId: before[1]?.id ?? null,
    };
  }

  const run = options.run ?? runCommand;
  const source = await qualifySource({
    environment: invocation.environment,
    commit: invocation.commit,
    run,
  });
  const temporary = options.outputDirectory === undefined;
  const output = options.outputDirectory ?? mkdtempSync(join(tmpdir(), "takoserver-site-"));
  try {
    await checked(run, "preflight", "scoped site build", [
      "bun",
      "scripts/build-site.ts",
      "--out",
      output,
      "--console",
      CONSOLE_ORIGIN,
      "--api",
      API_ORIGIN,
    ]);
    const artifact = sealDirectory(output, ["index.html"]);
    artifact.assertUnchanged();
    const branch = pagesBranch(invocation.environment, source);
    const upload = await run(
      wranglerCommand([
        "pages",
        "deploy",
        output,
        "--project-name",
        PAGES_PROJECT,
        "--branch",
        branch,
        "--commit-hash",
        source.commit,
        `--commit-dirty=${source.dirty ? "true" : "false"}`,
      ]),
      { env: environment },
    );
    if (upload.exitCode !== 0) {
      throw mutationError(
        "Pages upload acknowledgement is indeterminate; do not retry before --status",
        `${upload.stdout}${upload.stderr}`.trim(),
      );
    }
    const immutableUrl = parseImmutableUrl(`${upload.stdout}\n${upload.stderr}`);
    const index = readFileSync(join(output, "index.html"));
    const readback = await readbackOnce(
      immutableUrl,
      index,
      options.fetcher ?? ((input, init) => fetch(input, init)),
    );
    const productionReadback =
      invocation.environment === "production"
        ? await readbackOnce(
            `${SITE_ORIGIN}/`,
            index,
            options.fetcher ?? ((input, init) => fetch(input, init)),
          )
        : null;
    const after = pagesHistory(await state.pagesDeployments(PAGES_PROJECT));
    const deployed = after.find(
      (candidate) =>
        candidate.environment === lane &&
        candidate.successful &&
        candidate.commit === source.commit &&
        sameOrigin(candidate.url, immutableUrl),
    );
    if (!deployed) {
      throw verificationError(
        "Pages authoritative history does not contain the acknowledged commit and immutable URL",
      );
    }
    return {
      kind: "takoserver.site-apply@v2",
      surface: "takoserver-site",
      environment: invocation.environment,
      project: PAGES_PROJECT,
      commit: source.commit,
      branch,
      dirty: source.dirty,
      artifactDigest: artifact.digest,
      artifactBytes: artifact.bytes,
      artifactFiles: artifact.files,
      previousDeploymentId: previous?.id ?? null,
      deploymentId: deployed.id,
      immutableUrl,
      readback,
      productionReadback,
      rollback: pagesRollback(
        invocation.environment,
        options.accountId,
        deployed.id,
        previous?.id ?? null,
      ),
    };
  } finally {
    if (temporary) rmSync(output, { recursive: true, force: true });
  }
}

function pagesHistory(value: readonly unknown[]): readonly PagesDeployment[] {
  return value
    .map((entry) => {
      if (
        !isRecord(entry) ||
        typeof entry.id !== "string" ||
        typeof entry.url !== "string" ||
        typeof entry.created_on !== "string" ||
        !Number.isFinite(Date.parse(entry.created_on))
      ) {
        throw preflightError("Pages deployment history contains a malformed entry");
      }
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/u.test(entry.id)) {
        throw preflightError("Pages deployment history contains an invalid deployment id");
      }
      if (entry.environment !== "production" && entry.environment !== "preview") {
        throw preflightError("Pages deployment history contains an invalid environment");
      }
      const environment: PagesDeployment["environment"] = entry.environment;
      const latestStage = isRecord(entry.latest_stage) ? entry.latest_stage : null;
      if (!latestStage || typeof latestStage.status !== "string") {
        throw preflightError("Pages deployment history contains an invalid latest stage");
      }
      let url: URL;
      try {
        url = new URL(entry.url);
      } catch {
        throw preflightError("Pages deployment history contains an invalid URL");
      }
      if (url.protocol !== "https:" || !url.hostname.endsWith(`.${PAGES_PROJECT}.pages.dev`)) {
        throw preflightError("Pages deployment history contains an unexpected deployment URL");
      }
      const trigger = isRecord(entry.deployment_trigger) ? entry.deployment_trigger : null;
      const metadata = trigger && isRecord(trigger.metadata) ? trigger.metadata : null;
      const commit =
        metadata && typeof metadata.commit_hash === "string" ? metadata.commit_hash : null;
      return {
        id: entry.id,
        url: `${url.origin}/`,
        commit,
        createdOn: entry.created_on,
        environment,
        successful: latestStage.status === "success",
      };
    })
    .sort((left, right) => right.createdOn.localeCompare(left.createdOn));
}

function pagesRollback(
  environment: DeployEnvironment,
  accountId: string | undefined,
  deployedId: string,
  previousId: string | null,
): string {
  if (environment !== "production") {
    return (
      `wrangler pages deployment delete ${deployedId} --project-name ${PAGES_PROJECT} --force` +
      (previousId ? ` # previous provider-history deployment: ${previousId}` : "")
    );
  }
  if (previousId === null) {
    return "forward repair only: no previous production Pages deployment exists";
  }
  const account = exactAccount(accountId);
  const endpoint =
    `https://api.cloudflare.com/client/v4/accounts/${account}/pages/projects/${PAGES_PROJECT}` +
    `/deployments/${encodeURIComponent(previousId)}/rollback`;
  return (
    'curl --fail-with-body --request POST --header "Authorization: Bearer $CLOUDFLARE_API_TOKEN" ' +
    `--header "Content-Type: application/json" --data '{}' "${endpoint}"`
  );
}

function pagesBranch(environment: DeployEnvironment, source: SourceQualification): string {
  if (environment === "production") return "main";
  if (environment === "rehearsal") return "rehearsal";
  const branch = source.branch.replaceAll(/[^a-z0-9-]+/giu, "-").replaceAll(/^-+|-+$/gu, "");
  if (branch.length === 0 || branch === "main") {
    return `integration-${source.commit.slice(0, 12)}`;
  }
  return branch;
}

function parseImmutableUrl(output: string): string {
  for (const match of output.matchAll(/https:\/\/[^\s"'<>]+\.pages\.dev\/?/gu)) {
    const candidate = match[0];
    if (!candidate) continue;
    const url = new URL(candidate);
    if (
      url.protocol === "https:" &&
      url.hostname.endsWith(`.${PAGES_PROJECT}.pages.dev`) &&
      url.hostname !== `${PAGES_PROJECT}.pages.dev`
    ) {
      return `${url.origin}/`;
    }
  }
  throw mutationError(
    "Pages upload returned no immutable deployment URL; inspect history before retrying",
  );
}

async function readbackOnce(
  url: string,
  expected: Uint8Array,
  fetcher: StaticFetcher,
): Promise<{
  readonly url: string;
  readonly status: number;
  readonly digest: string;
  readonly bytes: number;
}> {
  let response: Response;
  try {
    response = await fetcher(url, {
      method: "GET",
      headers: { "cache-control": "no-cache" },
      redirect: "error",
    });
  } catch (error) {
    throw verificationError(
      `Pages immutable readback failed for ${url}`,
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
      `Pages immutable readback differs for ${url}`,
      `status=${response.status} digest=${digest} bytes=${body.byteLength}`,
    );
  }
  return { url, status: response.status, digest, bytes: body.byteLength };
}

async function checked(
  run: StaticProcess,
  phase: "preflight" | "mutation" | "verification",
  description: string,
  command: readonly string[],
): Promise<string> {
  const result = await run(command);
  if (result.exitCode !== 0) {
    throw new DeployError(
      phase,
      `${description} failed (exit ${result.exitCode})`,
      `${result.stdout}${result.stderr}`.trim(),
    );
  }
  return result.stdout;
}

function exactAccount(value: string | undefined): string {
  if (value === undefined) throw preflightError("site status requires the selected target account");
  return value;
}

function exactToken(environment: Readonly<Record<string, string>>): string {
  const value = environment.CLOUDFLARE_API_TOKEN;
  if (!value) throw preflightError("CLOUDFLARE_API_TOKEN is required");
  return value;
}

function sameOrigin(left: string, right: string): boolean {
  return new URL(left).origin === new URL(right).origin;
}

function sha256(value: Uint8Array): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
