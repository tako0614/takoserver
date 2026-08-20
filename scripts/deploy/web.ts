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
import { DeployError, preflightError } from "./errors.ts";
import { EVIDENCE_DIRECTORY } from "./evidence.ts";
import { REPOSITORY, runChecked, wranglerCommand } from "./process.ts";
import { resolvePushedCommit } from "./provenance.ts";
import type { DeployTarget } from "./target.ts";

export type WebSurface = "console" | "site";
export type WebAction = "status" | "plan" | "apply";

interface BuiltWebSurface {
  readonly surface: WebSurface;
  readonly workerName: string;
  readonly origin: string;
  readonly probePath: string;
  readonly directory: string;
  readonly digest: string;
  readonly bytes: number;
  readonly configPath: string;
  readonly cleanup: () => void;
}

interface WebEvidenceRecord {
  readonly kind: "takoserver.web-publication@v1";
  readonly publishedAt: string;
  readonly commit: string;
  readonly branch: string;
  readonly remoteUrl: string;
  readonly surface: WebSurface;
  readonly workerName: string;
  readonly origin: string;
  readonly bundleDigest: string;
  readonly bundleBytes: number;
  readonly previousService: string | null;
  readonly currentService: string;
}

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
    const live = await readLive(spec.origin, spec.probePath);
    process.stdout.write(`${JSON.stringify({ surface, ...spec, live }, null, 2)}\n`);
    return;
  }

  const source = await resolvePushedCommit();
  await runChecked("preflight", "portable gate `bun run check`", ["bun", "run", "check"]);
  const built = await buildWebSurface(surface, target, source.commit);
  try {
    const previousService = await currentDomainService(
      target.accountId,
      new URL(built.origin).hostname,
    );
    process.stdout.write(
      `${JSON.stringify(
        {
          surface,
          commit: source.commit,
          branch: source.branch,
          worker: built.workerName,
          origin: built.origin,
          bundleDigest: built.digest,
          bundleBytes: built.bytes,
          previousService,
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

    const currentService = await currentDomainService(
      target.accountId,
      new URL(built.origin).hostname,
    );
    if (currentService !== built.workerName) {
      throw new DeployError(
        "verification",
        `${built.origin} resolves to ${JSON.stringify(currentService)}, not ${built.workerName}`,
      );
    }
    await verifyPublishedBytes(built, source.commit);
    appendWebEvidence({
      kind: "takoserver.web-publication@v1",
      publishedAt: new Date().toISOString(),
      commit: source.commit,
      branch: source.branch,
      remoteUrl: source.remoteUrl,
      surface,
      workerName: built.workerName,
      origin: built.origin,
      bundleDigest: built.digest,
      bundleBytes: built.bytes,
      previousService,
      currentService,
    });
    process.stdout.write(
      `\nverified: ${built.origin}${built.probePath} is byte-exact ${built.digest}\n` +
        `evidence appended to ${WEB_EVIDENCE}\n` +
        `reversal: reattach ${new URL(built.origin).hostname} to ${previousService ?? "the previous Worker"}; no previous Worker was deleted\n`,
    );
  } finally {
    built.cleanup();
  }
}

export function webSurfaceSpec(
  surface: WebSurface,
  target: DeployTarget,
): { readonly workerName: string; readonly origin: string; readonly probePath: string } {
  if (surface === "console") {
    if (!target.consoleOrigin) throw preflightError("deploy target has no `consoleOrigin`");
    return {
      workerName: "takoserver-console",
      origin: target.consoleOrigin,
      probePath: "/console.js",
    };
  }
  if (!target.siteOrigin) throw preflightError("deploy target has no `siteOrigin`");
  return { workerName: "takoserver-site", origin: target.siteOrigin, probePath: "/" };
}

async function buildWebSurface(
  surface: WebSurface,
  target: DeployTarget,
  commit: string,
): Promise<BuiltWebSurface> {
  const spec = webSurfaceSpec(surface, target);
  const root = mkdtempSync(join(tmpdir(), `takoserver-${surface}-release-`));
  chmodSync(root, 0o700);
  const directory = join(root, "assets");
  const script = surface === "console" ? "scripts/build-console.ts" : "scripts/build-site.ts";
  const extra =
    surface === "console"
      ? ["--api-origin", target.publicOrigin]
      : [
          ...(target.consoleOrigin ? ["--console", target.consoleOrigin] : []),
          "--api",
          target.publicOrigin,
        ];
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
          name: spec.workerName,
          compatibility_date: "2026-08-20",
          workers_dev: false,
          assets: {
            directory,
            not_found_handling: surface === "console" ? "single-page-application" : "404-page",
          },
          routes: [{ pattern: new URL(spec.origin).hostname, custom_domain: true }],
          observability: { enabled: true },
          annotations: { "workers/message": `${spec.workerName} ${commit}` },
        },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    );
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
  if (!response.ok) throw preflightError("Cloudflare Worker domain inventory failed");
  const body = (await response.json()) as { readonly result?: readonly unknown[] };
  const matches = (body.result ?? []).filter(
    (entry): entry is { readonly hostname: string; readonly service: string } =>
      typeof entry === "object" &&
      entry !== null &&
      (entry as { hostname?: unknown }).hostname === hostname &&
      typeof (entry as { service?: unknown }).service === "string",
  );
  if (matches.length > 1) throw preflightError(`${hostname} has more than one Worker domain owner`);
  return matches[0]?.service ?? null;
}

async function readLive(
  origin: string,
  path: string,
): Promise<{ status: number; digest: string; bytes: number }> {
  const response = await fetch(`${origin}${path}?release-readback=${Date.now()}`, {
    headers: { "cache-control": "no-cache" },
    signal: AbortSignal.timeout(15_000),
  });
  const body = new Uint8Array(await response.arrayBuffer());
  return {
    status: response.status,
    digest: `sha256:${createHash("sha256").update(body).digest("hex")}`,
    bytes: body.byteLength,
  };
}

async function verifyPublishedBytes(built: BuiltWebSurface, commit: string): Promise<void> {
  const local = readFileSync(
    join(built.directory, built.probePath === "/" ? "index.html" : "console.js"),
  );
  const expected = `sha256:${createHash("sha256").update(local).digest("hex")}`;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const live = await readLive(built.origin, built.probePath);
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
