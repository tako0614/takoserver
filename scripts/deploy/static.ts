import { createHash } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { join, relative, resolve } from "node:path";
import { DeployError, mutationError, preflightError, verificationError } from "./errors.ts";
import { REPOSITORY, runChecked, runCommand, wranglerCommand } from "./process.ts";
import { resolvePushedCommit } from "./provenance.ts";

export type StaticSurfaceName = "takoserver-console" | "takoserver-site";

interface StaticSurface {
  readonly surface: StaticSurfaceName;
  readonly workerName: string;
  readonly configPath: string;
  readonly outputDirectory: string;
  readonly publicOrigin: string;
  readonly build: readonly string[];
}

const SURFACES: Readonly<Record<StaticSurfaceName, StaticSurface>> = {
  "takoserver-console": {
    surface: "takoserver-console",
    workerName: "takoserver-console",
    configPath: "wrangler.console.jsonc",
    outputDirectory: "console/dist",
    publicOrigin: "https://console.takoserver.com",
    build: ["bun", "scripts/build-console.ts", "--api-origin", "https://api.takoserver.com"],
  },
  "takoserver-site": {
    surface: "takoserver-site",
    workerName: "takoserver-site",
    configPath: "wrangler.site.jsonc",
    outputDirectory: "site/dist",
    publicOrigin: "https://takoserver.com",
    build: [
      "bun",
      "scripts/build-site.ts",
      "--console",
      "https://console.takoserver.com",
      "--api",
      "https://api.takoserver.com",
    ],
  },
};

interface StaticMode {
  readonly action: "status" | "plan" | "apply";
  readonly review?: string | undefined;
}

interface DeploymentState {
  readonly versionId: string;
  readonly createdOn: string;
}

interface Candidate {
  readonly commit: string;
  readonly branch: string;
  readonly remoteUrl: string;
  readonly digest: string;
  readonly files: number;
  readonly bytes: number;
  readonly previous: DeploymentState | null;
  readonly previousHttpStatus: number;
}

const CREDENTIAL_SHAPES = [
  /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/u,
  /\bAKIA[0-9A-Z]{16}\b/u,
  /\bsk_live_[0-9A-Za-z]{16,}\b/u,
  /\bgh[pousr]_[0-9A-Za-z]{30,}\b/u,
  /\bCLOUDFLARE_API_(?:TOKEN|KEY)\s*[=:]/u,
];

export async function runStaticSurface(
  surfaceName: StaticSurfaceName,
  args: readonly string[],
): Promise<void> {
  const mode = parseMode(args);
  if (mode === null) {
    throw preflightError(
      `${surfaceName} requires exactly one of --status, --plan, or --apply; ` +
        "--apply also requires --review <reviewer>",
    );
  }
  const surface = SURFACES[surfaceName];
  if (mode.action === "apply" && mode.review === undefined) {
    throw preflightError("--apply requires --review <reviewer>");
  }

  if (mode.action === "status") {
    const [deployment, response] = await Promise.all([
      readDeployment(surface.workerName),
      fetch(surface.publicOrigin, { headers: { "cache-control": "no-cache" } }).catch(() => null),
    ]);
    process.stdout.write(
      `${JSON.stringify(
        {
          kind: "takos.static-surface-status@v1",
          surface: surface.surface,
          workerName: surface.workerName,
          versionId: deployment?.versionId ?? null,
          publicOrigin: surface.publicOrigin,
          httpStatus: response?.status ?? null,
        },
        null,
        2,
      )}\n`,
    );
    return;
  }

  const candidate = await preflight(surface);
  process.stdout.write(
    `${JSON.stringify(
      {
        kind: "takos.static-surface-plan@v1",
        surface: surface.surface,
        workerName: surface.workerName,
        publicOrigin: surface.publicOrigin,
        commit: candidate.commit,
        branch: candidate.branch,
        artifactDigest: candidate.digest,
        files: candidate.files,
        bytes: candidate.bytes,
        previousVersionId: candidate.previous?.versionId ?? null,
        previousHttpStatus: candidate.previousHttpStatus,
      },
      null,
      2,
    )}\n`,
  );
  if (mode.action === "plan") {
    process.stdout.write("plan only: production was not changed\n");
    return;
  }
  if (mode.review === undefined) throw new TypeError("review invariant violated");

  const command = wranglerCommand([
    "deploy",
    "--strict",
    "--config",
    surface.configPath,
    "--message",
    `${surface.surface} ${candidate.commit}`,
  ]);
  let deployed: string;
  try {
    deployed = await runChecked("mutation", `${surface.surface} publication`, command);
  } catch (error) {
    if (error instanceof DeployError) {
      throw mutationError(
        `${surface.surface} publication is indeterminate; do not retry before --status`,
        [error.message, error.detail].filter((value) => value !== undefined).join("\n\n"),
      );
    }
    throw error;
  }
  process.stdout.write(deployed);

  const current = await waitForDeployment(
    surface.workerName,
    candidate.previous?.versionId ?? null,
  );
  await verify(surface);
  appendEvidence({
    publishedAt: new Date().toISOString(),
    surface: surface.surface,
    workerName: surface.workerName,
    publicOrigin: surface.publicOrigin,
    commit: candidate.commit,
    branch: candidate.branch,
    remoteUrl: candidate.remoteUrl,
    artifactDigest: candidate.digest,
    files: candidate.files,
    bytes: candidate.bytes,
    versionId: current.versionId,
    previousVersionId: candidate.previous?.versionId ?? null,
    reviewer: mode.review,
  });

  const reversal = candidate.previous
    ? `bunx wrangler rollback ${candidate.previous.versionId} --name ${surface.workerName} --yes`
    : `bunx wrangler delete ${surface.workerName} --config ${surface.configPath}`;
  process.stdout.write(
    `${JSON.stringify(
      {
        kind: "takos.deploy-result@v1",
        status: "PUBLISHED",
        surface: surface.surface,
        target: `cloudflare-worker:${surface.workerName}`,
        commit: candidate.commit,
        artifactDigest: candidate.digest,
        versionId: current.versionId,
        previousVersionId: candidate.previous?.versionId ?? null,
        reviewer: mode.review,
        readback: "EXPECTED_CANDIDATE",
        reversal,
      },
      null,
      2,
    )}\n`,
  );
}

function parseMode(args: readonly string[]): StaticMode | null {
  let action: StaticMode["action"] | null = null;
  let review: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--status" || argument === "--plan" || argument === "--apply") {
      if (action !== null) return null;
      action = argument.slice(2) as StaticMode["action"];
      continue;
    }
    if (argument === "--review") {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--") || review !== undefined) return null;
      review = value;
      index += 1;
      continue;
    }
    return null;
  }
  if (action === null || (action !== "apply" && review !== undefined)) return null;
  return review === undefined ? { action } : { action, review };
}

async function preflight(surface: StaticSurface): Promise<Candidate> {
  const source = await resolvePushedCommit();
  await runChecked("preflight", "portable gate `bun run check`", ["bun", "run", "check"]);
  await runChecked("preflight", `${surface.surface} production build`, surface.build);

  const artifact = artifactIdentity(resolve(REPOSITORY, surface.outputDirectory));
  await runChecked(
    "preflight",
    `${surface.surface} strict Wrangler dry-run`,
    wranglerCommand(["deploy", "--dry-run", "--strict", "--config", surface.configPath]),
  );
  const [previous, response] = await Promise.all([
    readDeployment(surface.workerName),
    fetch(surface.publicOrigin, { headers: { "cache-control": "no-cache" } }).catch(() => null),
  ]);
  return {
    ...source,
    ...artifact,
    previous,
    previousHttpStatus: response?.status ?? 0,
  };
}

function artifactIdentity(directory: string): {
  readonly digest: string;
  readonly files: number;
  readonly bytes: number;
} {
  const paths = walk(directory).sort();
  if (paths.length === 0 || !paths.some((path) => relative(directory, path) === "index.html")) {
    throw preflightError("static build produced no index.html");
  }
  const hash = createHash("sha256");
  let bytes = 0;
  for (const path of paths) {
    const name = relative(directory, path);
    if (/(^|\/)\.env(\.|$)|\.(?:pem|p12|pfx|key)$/u.test(name)) {
      throw preflightError(`public artifact contains credential-shaped file ${name}`);
    }
    const contents = readFileSync(path);
    if (!/\.(?:png|jpe?g|webp|avif|gif|ico|woff2?|ttf|otf|mp4|pdf)$/u.test(name)) {
      const source = contents.toString("utf8");
      if (CREDENTIAL_SHAPES.some((shape) => shape.test(source))) {
        throw preflightError(`public artifact ${name} contains credential-shaped bytes`);
      }
    }
    hash.update(name);
    hash.update("\0");
    hash.update(contents);
    bytes += contents.byteLength;
  }
  return { digest: `sha256:${hash.digest("hex")}`, files: paths.length, bytes };
}

function walk(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

async function readDeployment(workerName: string): Promise<DeploymentState | null> {
  const result = await runCommand(
    wranglerCommand(["deployments", "list", "--name", workerName, "--json"]),
  );
  if (result.exitCode !== 0) {
    if (result.stderr.includes("does not exist on your account")) return null;
    throw preflightError(`cannot read ${workerName} deployment state`, result.stderr);
  }
  const deployments = JSON.parse(result.stdout) as readonly {
    readonly created_on: string;
    readonly versions: readonly { readonly version_id: string; readonly percentage: number }[];
  }[];
  const current = [...deployments]
    .sort((left, right) => right.created_on.localeCompare(left.created_on))
    .find(
      (deployment) =>
        deployment.versions.length === 1 && deployment.versions[0]?.percentage === 100,
    );
  const versionId = current?.versions[0]?.version_id;
  if (current === undefined || versionId === undefined) return null;
  return { versionId, createdOn: current.created_on };
}

async function waitForDeployment(
  workerName: string,
  previousVersionId: string | null,
): Promise<DeploymentState> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const current = await readDeployment(workerName);
    if (current !== null && current.versionId !== previousVersionId) return current;
    await Bun.sleep(1_000 * (attempt + 1));
  }
  throw verificationError(`${workerName} did not expose a new 100% deployment`);
}

async function verify(surface: StaticSurface): Promise<void> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      if (surface.surface === "takoserver-console") await verifyConsole(surface);
      else await verifySite(surface);
      return;
    } catch (error) {
      if (attempt === 7) {
        throw verificationError(
          `${surface.surface} published but served-byte verification did not converge`,
          error instanceof Error ? error.message : String(error),
        );
      }
      await Bun.sleep(1_000 * (attempt + 1));
    }
  }
}

async function verifyConsole(surface: StaticSurface): Promise<void> {
  const localRoot = resolve(REPOSITORY, surface.outputDirectory);
  const [index, script, deepLink] = await Promise.all([
    get(`${surface.publicOrigin}/`),
    get(`${surface.publicOrigin}/console.js`),
    get(`${surface.publicOrigin}/catalog`, { "sec-fetch-mode": "navigate", accept: "text/html" }),
  ]);
  exactBytes(index, readFileSync(join(localRoot, "index.html")), "console index");
  exactBytes(script, readFileSync(join(localRoot, "console.js")), "console script");
  exactBytes(deepLink, readFileSync(join(localRoot, "index.html")), "console deep link");
  const source = script.toString("utf8");
  if (source.includes("unitPriceMinor") || source.includes(".protocols")) {
    throw new Error("served Console still contains the retired Offering projection");
  }
}

async function verifySite(surface: StaticSurface): Promise<void> {
  const localRoot = resolve(REPOSITORY, surface.outputDirectory);
  const [root, english, japanese] = await Promise.all([
    get(`${surface.publicOrigin}/`),
    get(`${surface.publicOrigin}/en/`),
    get(`${surface.publicOrigin}/ja/`),
  ]);
  exactBytes(root, readFileSync(join(localRoot, "index.html")), "site default English index");
  exactBytes(english, readFileSync(join(localRoot, "en", "index.html")), "site English index");
  exactBytes(japanese, readFileSync(join(localRoot, "ja", "index.html")), "site Japanese index");
  const html = root.toString("utf8");
  if (
    !html.includes("https://console.takoserver.com") ||
    !html.includes("https://api.takoserver.com")
  ) {
    throw new Error("served site does not link the Console and API");
  }
  if (
    !english.toString("utf8").includes('<html lang="en">') ||
    !japanese.toString("utf8").includes('<html lang="ja">')
  ) {
    throw new Error("served site locale documents do not declare exact language identity");
  }
}

async function get(url: string, headers: Readonly<Record<string, string>> = {}): Promise<Buffer> {
  const response = await fetch(url, {
    headers: { "cache-control": "no-cache", ...headers },
    redirect: "follow",
  });
  if (!response.ok) throw new Error(`${url} responded ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

function exactBytes(actual: Buffer, expected: Buffer, label: string): void {
  if (!actual.equals(expected)) {
    throw new Error(`${label} digest mismatch`);
  }
}

function appendEvidence(record: Readonly<Record<string, unknown>>): void {
  const directory = resolve(REPOSITORY, ".deploy/evidence");
  const path = join(directory, "static-published.jsonl");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  appendFileSync(path, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  const descriptor = openSync(path, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}
