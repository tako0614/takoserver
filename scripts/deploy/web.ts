import { createHash } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { DeployError, type DeployPhase, preflightError } from "./errors.ts";
import { EVIDENCE_DIRECTORY } from "./evidence.ts";
import { REPOSITORY, runChecked, wranglerCommand } from "./process.ts";
import { resolvePushedCommit } from "./provenance.ts";
import type { DeployTarget } from "./target.ts";

export type WebSurface = "console";
export type WebAction = "status" | "plan" | "apply";
type WebFetcher = (input: string, init?: RequestInit) => Promise<Response>;

export interface DeclaredWebRoute {
  readonly kind: "custom-domain";
  readonly pattern: string;
}

export interface WebDeploymentDeclaration {
  readonly accountIdentity: string;
  readonly workerName: string;
  readonly origin: string;
  readonly probePath: string;
  readonly route: DeclaredWebRoute;
}

const WEB_READBACK_TIMEOUT_MS = 15_000;

interface BuiltWebSurface {
  readonly surface: WebSurface;
  readonly workerName: string;
  readonly origin: string;
  readonly probePath: string;
  readonly directory: string;
  readonly digest: string;
  readonly bytes: number;
  readonly configPath: string;
  readonly accountIdentity: string;
  readonly declaredRoute: DeclaredWebRoute;
  readonly cleanup: () => void;
}

interface WebEvidenceRecord {
  readonly kind: "takoserver.web-publication@v2";
  readonly publishedAt: string;
  readonly commit: string;
  readonly branch: string;
  readonly remoteUrl: string;
  readonly surface: WebSurface;
  readonly workerName: string;
  readonly origin: string;
  readonly accountIdentity: string;
  readonly bundleDigest: string;
  readonly bundleBytes: number;
  readonly declaredRoute: DeclaredWebRoute;
  readonly previousPublicState: WebPublicState;
  readonly previousService: string | null;
  readonly currentService: string;
  readonly reversal: string;
}

/**
 * Console status keeps transport failures explicit so a missing/unhealthy
 * origin cannot be mistaken for a successful empty response in release
 * evidence. The Pages site has its own readback model in static.ts.
 */
type WebPublicState =
  | {
      readonly outcome: "response";
      readonly status: number;
      readonly digest: string;
      readonly bytes: number;
    }
  | {
      readonly outcome: "timeout" | "transport";
      readonly status: null;
      readonly digest: null;
      readonly bytes: null;
    };

const WEB_EVIDENCE = resolve(EVIDENCE_DIRECTORY, "web-published.jsonl");

/**
 * Public web surfaces are first-party product bytes, not customer resources.
 * They therefore have an owning release lane rather than being left behind in
 * a previous Takoserver database as an unowned StaticAssetBundle.
 */
export async function runWebRelease(
  surface: WebSurface,
  action: WebAction,
  target: DeployTarget,
): Promise<void> {
  const spec = webSurfaceSpec(surface, target);
  if (action === "status") {
    const live = await readLive(spec.origin, spec.probePath, "preflight");
    if (live.status !== 200) {
      throw preflightError(
        `public ${surface} readback returned HTTP ${live.status}`,
        `${spec.origin}${spec.probePath} did not return the expected HTTP 200 response`,
      );
    }
    process.stdout.write(`${JSON.stringify({ surface, ...spec, live }, null, 2)}\n`);
    return;
  }

  const source = await resolvePushedCommit();
  await runChecked("preflight", "portable gate `bun run check`", ["bun", "run", "check"]);
  const built = await buildWebSurface(surface, target, source.commit);
  try {
    const previousState = {
      routeOwner: await currentWebOwner(target.accountId, built.origin),
      publicState: await readPublicState(built.origin, built.probePath),
    };
    const previousService = previousState.routeOwner;
    process.stdout.write(
      `${JSON.stringify(
        {
          surface,
          commit: source.commit,
          branch: source.branch,
          worker: built.workerName,
          origin: built.origin,
          accountIdentity: built.accountIdentity,
          bundleDigest: built.digest,
          bundleBytes: built.bytes,
          declaredRoute: built.declaredRoute,
          previousService,
          previousPublicState: previousState.publicState,
          reversal: webReversalNotice(built.workerName, built.declaredRoute, previousService),
        },
        null,
        2,
      )}\n`,
    );
    if (action === "plan") {
      process.stdout.write(
        "\nplan only: source, build, domain authority and gate passed; nothing was published\n",
      );
      return;
    }

    await runChecked(
      "mutation",
      `${surface} Worker publication`,
      wranglerCommand([
        "deploy",
        "--config",
        built.configPath,
        "--strict",
        "--message",
        `${built.workerName} ${source.commit}`,
      ]),
    );

    const currentService = await currentWebOwner(target.accountId, built.origin);
    if (currentService !== built.workerName) {
      throw new DeployError(
        "verification",
        `${built.origin} resolves to ${JSON.stringify(currentService)}, not ${built.workerName}`,
      );
    }
    await verifyPublishedBytes(built, source.commit);
    const reversal = webReversalNotice(built.workerName, built.declaredRoute, previousService);
    appendWebEvidence({
      kind: "takoserver.web-publication@v2",
      publishedAt: new Date().toISOString(),
      commit: source.commit,
      branch: source.branch,
      remoteUrl: source.remoteUrl,
      surface,
      workerName: built.workerName,
      origin: built.origin,
      accountIdentity: built.accountIdentity,
      bundleDigest: built.digest,
      bundleBytes: built.bytes,
      declaredRoute: built.declaredRoute,
      previousPublicState: previousState.publicState,
      previousService,
      currentService,
      reversal,
    });
    process.stdout.write(
      `\nverified: ${built.origin}${built.probePath} is byte-exact ${built.digest}\n` +
        `evidence appended to ${WEB_EVIDENCE}\n` +
        `${reversal}\n`,
    );
  } finally {
    built.cleanup();
  }
}

export function webSurfaceSpec(
  _surface: WebSurface,
  target: DeployTarget,
): { readonly workerName: string; readonly origin: string; readonly probePath: string } {
  if (!target.consoleOrigin) throw preflightError("deploy target has no `consoleOrigin`");
  return {
    workerName: "takoserver-console",
    origin: target.consoleOrigin,
    probePath: "/console.js",
  };
}

/** The one target-derived deployment identity consumed by status, plan, and apply. */
export function loadWebDeploymentDeclaration(
  surface: WebSurface,
  target: DeployTarget,
): WebDeploymentDeclaration {
  const spec = webSurfaceSpec(surface, target);
  const hostname = new URL(spec.origin).hostname;
  return {
    accountIdentity: `sha256:${createHash("sha256").update(target.accountId).digest("hex")}`,
    ...spec,
    route: { kind: "custom-domain", pattern: hostname },
  };
}

export function webReversalNotice(
  workerName: string,
  route: DeclaredWebRoute,
  previousService: string | null,
): string {
  const target = `custom domain ${route.pattern}`;
  return previousService === null
    ? `reversal: remove the exact ${target} from ${workerName} to restore no owner; no previous Worker was attached`
    : `reversal: reattach ${target} to ${previousService}; no previous Worker was deleted`;
}

export function readDeclaredWebRoute(
  surface: WebSurface,
  origin: string,
  accountId: string,
  configPath: string,
): DeclaredWebRoute {
  let config: unknown;
  try {
    config = JSON.parse(readFileSync(configPath, "utf8"));
  } catch {
    throw preflightError(`${surface} Wrangler config is not valid JSON`);
  }
  if (typeof config !== "object" || config === null) {
    throw preflightError(`${surface} Wrangler config must be an object`);
  }
  const record = config as Record<string, unknown>;
  const workerName = `takoserver-${surface}`;
  if (record.account_id !== accountId) {
    throw preflightError(`${surface} Wrangler config must bind the exact reviewed account`);
  }
  if (record.name !== workerName || record.workers_dev !== false) {
    throw preflightError(`${surface} Wrangler config does not name its exact public Worker`);
  }
  const hostname = new URL(origin).hostname;
  const routes = record.routes;
  const route = Array.isArray(routes) && routes.length === 1 ? routes[0] : null;
  if (typeof route !== "object" || route === null) {
    throw preflightError(
      `console Wrangler config must declare one exact custom domain ${hostname}`,
    );
  }
  const candidate = route as Record<string, unknown>;
  const exactKeys = Object.keys(candidate).sort().join(",") === "custom_domain,pattern";
  if (!exactKeys || candidate.pattern !== hostname || candidate.custom_domain !== true) {
    throw preflightError(
      `console Wrangler config must declare the exact custom domain ${hostname}`,
    );
  }
  return { kind: "custom-domain", pattern: hostname };
}

async function buildWebSurface(
  surface: WebSurface,
  target: DeployTarget,
  commit: string,
): Promise<BuiltWebSurface> {
  const declaration = loadWebDeploymentDeclaration(surface, target);
  const spec = declaration;
  const root = mkdtempSync(join(tmpdir(), `takoserver-${surface}-release-`));
  chmodSync(root, 0o700);
  const directory = join(root, "assets");
  const script = "scripts/build-console.ts";
  const extra = ["--api-origin", target.publicOrigin];
  try {
    await runChecked("preflight", `${surface} asset build`, [
      "bun",
      script,
      "--out",
      directory,
      ...extra,
    ]);
    const { digest, bytes } = digestDirectory(directory);
    const configPath = join(root, "wrangler.jsonc");
    writeFileSync(
      configPath,
      `${JSON.stringify(
        {
          $schema: resolve(REPOSITORY, "node_modules/wrangler/config-schema.json"),
          account_id: target.accountId,
          name: spec.workerName,
          compatibility_date: "2026-08-20",
          workers_dev: false,
          assets: {
            directory,
            not_found_handling: "single-page-application",
          },
          routes: [{ pattern: declaration.route.pattern, custom_domain: true }],
          observability: { enabled: true },
          annotations: { "workers/message": `${spec.workerName} ${commit}` },
        },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    );
    const declaredRoute = readDeclaredWebRoute(surface, spec.origin, target.accountId, configPath);
    await runChecked(
      "preflight",
      `${surface} Wrangler strict dry-run`,
      wranglerCommand(["deploy", "--dry-run", "--strict", "--config", configPath]),
    );
    return {
      surface,
      ...spec,
      directory,
      digest,
      bytes,
      configPath,
      accountIdentity: declaration.accountIdentity,
      declaredRoute,
      cleanup: () => rmSync(root, { recursive: true, force: true }),
    };
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

export function digestDirectory(directory: string): {
  readonly digest: string;
  readonly bytes: number;
} {
  const files = walk(directory).sort();
  const hash = createHash("sha256");
  let bytes = 0;
  for (const path of files) {
    const body = readFileSync(path);
    const name = relative(directory, path).replaceAll("\\", "/");
    hash.update(`${name}\0${body.byteLength}\0`);
    hash.update(body);
    bytes += body.byteLength;
  }
  return { digest: `sha256:${hash.digest("hex")}`, bytes };
}

function walk(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

async function currentDomainService(accountId: string, hostname: string): Promise<string | null> {
  const token = process.env.CLOUDFLARE_API_TOKEN?.trim();
  if (!token) throw preflightError("CLOUDFLARE_API_TOKEN is required for web domain authority");
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/domains`,
    { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) },
  );
  const result = await cloudflareEnvelope(response, "Cloudflare Worker domain inventory");
  const matches = result.filter(
    (entry): entry is { readonly hostname: string; readonly service: string } =>
      typeof entry === "object" &&
      entry !== null &&
      (entry as { hostname?: unknown }).hostname === hostname &&
      typeof (entry as { service?: unknown }).service === "string",
  );
  if (matches.length > 1) throw preflightError(`${hostname} has more than one Worker domain owner`);
  return matches[0]?.service ?? null;
}

async function currentWebOwner(accountId: string, origin: string): Promise<string | null> {
  const hostname = new URL(origin).hostname;
  return currentDomainService(accountId, hostname);
}

async function cloudflareEnvelope(response: Response, label: string): Promise<readonly unknown[]> {
  if (!response.ok) throw preflightError(`${label} failed`);
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw preflightError(`${label} returned malformed response`);
  }
  if (
    typeof body !== "object" ||
    body === null ||
    (body as { success?: unknown }).success !== true ||
    !Array.isArray((body as { result?: unknown }).result)
  ) {
    throw preflightError(`${label} returned malformed response`);
  }
  return (body as { result: readonly unknown[] }).result;
}

async function readPublicState(
  origin: string,
  path: string,
  fetcher?: WebFetcher,
): Promise<WebPublicState> {
  try {
    const live = await readLive(origin, path, "preflight", fetcher);
    return { outcome: "response", ...live };
  } catch (error) {
    if (!(error instanceof DeployError) || error.phase !== "preflight") throw error;
    const detail = error.detail ?? "";
    const timedOut = error.message.includes("timed out") || detail.startsWith("timeout:");
    return {
      outcome: timedOut ? "timeout" : "transport",
      status: null,
      digest: null,
      bytes: null,
    };
  }
}

export async function readLive(
  origin: string,
  path: string,
  phase: DeployPhase,
  fetcher: WebFetcher = (input, init) => fetch(input, init),
): Promise<{ status: number; digest: string; bytes: number }> {
  const signal = AbortSignal.timeout(WEB_READBACK_TIMEOUT_MS);
  try {
    const response = await fetcher(`${origin}${path}?release-readback=${Date.now()}`, {
      headers: { "cache-control": "no-cache" },
      signal,
    });
    const body = new Uint8Array(await response.arrayBuffer());
    return {
      status: response.status,
      digest: `sha256:${createHash("sha256").update(body).digest("hex")}`,
      bytes: body.byteLength,
    };
  } catch (error) {
    const timedOut = signal.aborted || (error instanceof Error && error.name === "TimeoutError");
    const classification = timedOut ? "timeout" : "transport";
    const cause = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    throw new DeployError(
      phase,
      timedOut ? "public web readback timed out" : "public web readback transport failed",
      `${classification}: ${origin}${path}: ${cause}`,
    );
  }
}

async function verifyPublishedBytes(built: BuiltWebSurface, commit: string): Promise<void> {
  const local = readFileSync(
    join(built.directory, built.probePath === "/" ? "index.html" : "console.js"),
  );
  const expected = `sha256:${createHash("sha256").update(local).digest("hex")}`;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const live = await readLive(built.origin, built.probePath, "verification");
    if (live.status === 200 && live.digest === expected && live.bytes === local.byteLength) return;
    await Bun.sleep(1_000);
  }
  throw new DeployError(
    "verification",
    `${built.origin}${built.probePath} did not converge to ${expected} for ${commit}`,
  );
}

function appendWebEvidence(record: WebEvidenceRecord): void {
  mkdirSync(EVIDENCE_DIRECTORY, { recursive: true, mode: 0o700 });
  appendFileSync(WEB_EVIDENCE, `${JSON.stringify(record)}\n`, { mode: 0o600 });
}
