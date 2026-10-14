import { randomBytes } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { CloudflareState } from "./cloudflare-state.ts";
import { mutationError, preflightError, verificationError } from "./errors.ts";
import {
  moneyShadowHash,
  moneyShadowProtectedBytes,
  moneyShadowProtectedDirectory,
  moneyShadowWriteOnce,
} from "./integration-money-shadow-create.ts";
import { readMigrationArtifact } from "./migrations.ts";
import { REPOSITORY, resolveCloudflareCredential, runCommand, WRANGLER } from "./process.ts";
import { qualifySource, removeArtifactTree, sealDirectory } from "./qualification.ts";
import {
  buildMoneyRehearsalSyntheticPlan,
  type IntegrationMoneyShadowRehearsalDeclaration,
  runIntegrationMoneyShadowRehearsal,
} from "./schema-money-unit-rehearsal.ts";
import { exactV2MaintenanceModuleDigest } from "./schema-v2-existing-transition.ts";
import { canonicalizeWorkerBundleSource } from "./worker-artifact.ts";
import { workerVersionIdentity } from "./worker-live.ts";
import {
  assertExactSecretInventory,
  assertExactVersionBindingClosure,
  parseWorkerDeploymentHistory,
} from "./worker-state.ts";
import {
  acquireWranglerVersionPublicationLease,
  deployWranglerLifecycleChange,
} from "./wrangler-state.ts";

const ACCOUNT = /^[0-9a-f]{32}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const COMMIT = /^[0-9a-f]{40}$/u;
const SHA = /^sha256:[0-9a-f]{64}$/u;
const NAME = /^takoserver-ms-[0-9a-f]{32}$/u;
const AUTH = /^[0-9a-f]{64}\n$/u;
const AUTH_NAME = "MONEY_SHADOW_PROBE_AUTH";
const SURFACE = "takoserver-integration-money-shadow-native-probe";

export interface MoneyShadowNativeProbeDeclaration {
  readonly kind: "takoserver.integration-money-shadow-native-probe@v1";
  readonly environment: "integration";
  readonly accountId: string;
  readonly databaseName: string;
  readonly databaseId: string;
  readonly rehearsalDeclarationPath: string;
  readonly rehearsalDeclarationDigest: string;
  readonly rehearsalSourceCommit: string;
  readonly authPath: string;
  readonly reviewPath: string;
  readonly custodyDirectory: string;
  readonly phase: "publish" | "probe";
}

export interface MoneyShadowNativeProbeInvocation {
  readonly action: "status" | "apply";
  readonly environment: "integration";
  readonly commit: string;
}

interface ProbeStatus {
  readonly state: "absent" | "started" | "complete" | "failed";
  readonly bindingDigest: string;
  readonly sourceCommit: string;
  readonly resultDigest: string | null;
  readonly completeReadbackMatches: boolean | null;
  readonly permitEmpty: boolean;
  readonly writerEpochMatches: boolean;
}

interface NativeWorker {
  readonly versionId: string;
  readonly deploymentId: string;
  readonly moduleDigest: string;
  readonly endpoint: string;
}

export function assertMoneyShadowProbeNativeRefence(
  expected: NativeWorker,
  current: NativeWorker,
): void {
  if (
    current.versionId !== expected.versionId ||
    current.deploymentId !== expected.deploymentId ||
    current.moduleDigest !== expected.moduleDigest ||
    current.endpoint !== expected.endpoint
  )
    throw verificationError("shadow diagnostic Worker changed after probe status readback");
}

export async function terminalizeMoneyShadowProbeAfterNativeRefence(input: {
  readonly terminalPath: string;
  readonly declaration: MoneyShadowNativeProbeDeclaration;
  readonly bindingDigest: string;
  readonly expectedNative: NativeWorker;
  readonly resultDigest: string;
  readonly readNative: () => Promise<NativeWorker>;
}): Promise<void> {
  const refenced = await input.readNative();
  assertMoneyShadowProbeNativeRefence(input.expectedNative, refenced);
  moneyShadowWriteOnce(
    input.terminalPath,
    `${JSON.stringify({
      kind: "takoserver.money-shadow-native-probe-terminal@v1",
      phase: "probe",
      bindingDigest: input.bindingDigest,
      accountId: input.declaration.accountId,
      databaseId: input.declaration.databaseId,
      workerName: workerName(input.declaration.databaseName),
      versionId: refenced.versionId,
      deploymentId: refenced.deploymentId,
      nativeResultDigest: input.resultDigest,
    })}\n`,
  );
}

interface ProbeBinding {
  readonly kind: "takoserver.money-shadow-native-probe-binding@v1";
  readonly phase: "publish" | "probe";
  readonly accountId: string;
  readonly databaseName: string;
  readonly databaseId: string;
  readonly workerName: string;
  readonly sourceCommit: string;
  readonly rehearsalSourceCommit: string;
  readonly rehearsalDeclarationDigest: string;
  readonly rehearsalApplicationDigest: string;
  readonly rehearsalFinancialDigest: string;
  readonly rehearsalShapeDigest: string;
  readonly writerEpoch: string;
  readonly revokedEpoch: string;
  readonly authDigest: string;
  readonly authGenesisDigest: string;
  readonly workerBindingDigest: string;
  readonly bundleDigest: string;
  readonly configDigest: string;
  readonly publicationTerminalDigest?: string;
  readonly nativeVersionId?: string;
  readonly nativeDeploymentId?: string;
  readonly nativeStatusDigest?: string;
}

export interface MoneyShadowNativeProbeOptions {
  /** Local test seams only. Normal CLI supplies none of these. */
  readonly run?: typeof runCommand;
  readonly fetcher?: (request: Request) => Promise<Response>;
  readonly cloudflareEnvironment?: Readonly<Record<string, string>>;
  readonly state?: CloudflareState;
  readonly wranglerPath?: string;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readProtectedJson(path: string, label: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(moneyShadowProtectedBytes(path, label).toString("utf8"));
  } catch {
    throw preflightError(`${label} is unavailable or malformed`);
  }
  if (!record(value)) throw preflightError(`${label} is not an object`);
  return value;
}

function sameKeys(value: Record<string, unknown>, names: readonly string[]): boolean {
  return Object.keys(value).sort().join(",") === [...names].sort().join(",");
}

function validateDeclaration(value: MoneyShadowNativeProbeDeclaration): void {
  if (
    !record(value) ||
    !sameKeys(value, [
      "kind",
      "environment",
      "accountId",
      "databaseName",
      "databaseId",
      "rehearsalDeclarationPath",
      "rehearsalDeclarationDigest",
      "rehearsalSourceCommit",
      "authPath",
      "reviewPath",
      "custodyDirectory",
      "phase",
    ]) ||
    value.kind !== "takoserver.integration-money-shadow-native-probe@v1" ||
    value.environment !== "integration" ||
    !ACCOUNT.test(value.accountId) ||
    !NAME.test(value.databaseName) ||
    !UUID.test(value.databaseId) ||
    !SHA.test(value.rehearsalDeclarationDigest) ||
    !COMMIT.test(value.rehearsalSourceCommit) ||
    (value.phase !== "publish" && value.phase !== "probe")
  )
    throw preflightError("money shadow native probe requires exact integration-only declaration");
  moneyShadowProtectedDirectory(value.custodyDirectory);
  for (const path of [value.authPath, value.reviewPath, value.rehearsalDeclarationPath]) {
    if (!path.startsWith("/") || !relative(REPOSITORY, path).startsWith(".."))
      throw preflightError("money shadow native probe evidence must be outside repository");
    moneyShadowProtectedDirectory(dirname(path));
  }
}

function exactRehearsalDeclaration(
  value: MoneyShadowNativeProbeDeclaration,
): IntegrationMoneyShadowRehearsalDeclaration {
  const bytes = moneyShadowProtectedBytes(
    value.rehearsalDeclarationPath,
    "terminal shadow rehearsal declaration",
  );
  if (moneyShadowHash(bytes) !== value.rehearsalDeclarationDigest)
    throw preflightError("terminal shadow rehearsal declaration changed");
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw preflightError("terminal shadow rehearsal declaration is malformed");
  }
  if (
    !record(parsed) ||
    parsed.kind !== "takoserver.integration-money-shadow-rehearsal@v1" ||
    parsed.environment !== "integration" ||
    parsed.phase !== "permit-success" ||
    parsed.accountId !== value.accountId ||
    parsed.databaseName !== value.databaseName ||
    parsed.databaseId !== value.databaseId
  )
    throw preflightError("native probe requires terminal permit-success on the exact shadow D1");
  return parsed as unknown as IntegrationMoneyShadowRehearsalDeclaration;
}

async function auth(
  declaration: MoneyShadowNativeProbeDeclaration,
  invocation: MoneyShadowNativeProbeInvocation,
  token: string,
  fetcher: (request: Request) => Promise<Response>,
  run: typeof runCommand,
): Promise<{ readonly secret: string; readonly digest: string; readonly genesisDigest: string }> {
  const genesisPath = join(declaration.custodyDirectory, "auth.genesis.json");
  const existingSecret = existsSync(declaration.authPath);
  const existingGenesis = existsSync(genesisPath);
  if (existingSecret !== existingGenesis)
    throw preflightError("shadow-only auth or its source-generated genesis receipt is missing");
  if (!existingSecret) {
    if (invocation.action !== "status" || declaration.phase !== "publish")
      throw preflightError("shadow-only auth must originate from first publication status");
    if (
      await readExactMoneyShadowProbeWorkerPresence(
        declaration.accountId,
        workerName(declaration.databaseName),
        token,
        fetcher,
      )
    )
      throw preflightError("shadow diagnostic Worker already exists before auth genesis");
    const source = await qualifySource({
      environment: "integration",
      commit: invocation.commit,
      policy: "clean-remote",
      run,
    });
    if (source.remoteRef === null)
      throw preflightError("shadow auth genesis requires remotely reachable source");
    const secretBytes = `${randomBytes(32).toString("hex")}\n`;
    moneyShadowWriteOnce(declaration.authPath, secretBytes);
    moneyShadowWriteOnce(
      genesisPath,
      `${JSON.stringify({
        kind: "takoserver.money-shadow-native-auth-genesis@v1",
        accountId: declaration.accountId,
        databaseName: declaration.databaseName,
        databaseId: declaration.databaseId,
        workerName: workerName(declaration.databaseName),
        sourceCommit: invocation.commit,
        sourceRemoteRef: source.remoteRef,
        rehearsalSourceCommit: declaration.rehearsalSourceCommit,
        rehearsalDeclarationDigest: declaration.rehearsalDeclarationDigest,
        authPath: declaration.authPath,
        authDigest: moneyShadowHash(secretBytes),
        firstAbsence: "authenticated-exact-worker-get-404-code10007",
      })}\n`,
    );
  }
  const genesisBytes = moneyShadowProtectedBytes(genesisPath, "shadow-only auth genesis");
  const genesis = readProtectedJson(genesisPath, "shadow-only auth genesis");
  const bytes = moneyShadowProtectedBytes(declaration.authPath, "shadow-only probe auth");
  const source = bytes.toString("utf8");
  if (
    !sameKeys(genesis, [
      "kind",
      "accountId",
      "databaseName",
      "databaseId",
      "workerName",
      "sourceCommit",
      "sourceRemoteRef",
      "rehearsalSourceCommit",
      "rehearsalDeclarationDigest",
      "authPath",
      "authDigest",
      "firstAbsence",
    ]) ||
    genesis.kind !== "takoserver.money-shadow-native-auth-genesis@v1" ||
    genesis.accountId !== declaration.accountId ||
    genesis.databaseName !== declaration.databaseName ||
    genesis.databaseId !== declaration.databaseId ||
    genesis.workerName !== workerName(declaration.databaseName) ||
    genesis.sourceCommit !== invocation.commit ||
    typeof genesis.sourceRemoteRef !== "string" ||
    genesis.sourceRemoteRef.length === 0 ||
    genesis.rehearsalSourceCommit !== declaration.rehearsalSourceCommit ||
    genesis.rehearsalDeclarationDigest !== declaration.rehearsalDeclarationDigest ||
    genesis.authPath !== declaration.authPath ||
    genesis.firstAbsence !== "authenticated-exact-worker-get-404-code10007" ||
    !AUTH.test(source) ||
    bytes.length !== 65 ||
    genesis.authDigest !== moneyShadowHash(bytes)
  )
    throw preflightError("shadow-only auth differs from source-generated genesis receipt");
  return {
    secret: source.slice(0, -1),
    digest: moneyShadowHash(bytes),
    genesisDigest: moneyShadowHash(genesisBytes),
  };
}

function readReview(path: string, bindingDigest: string): string | null {
  if (!existsSync(path)) return null;
  const value = readProtectedJson(path, "shadow native probe independent review");
  if (
    !sameKeys(value, [
      "kind",
      "decision",
      "bindingDigest",
      "evidencePath",
      "evidenceDigest",
      "reviewer",
      "reviewedAt",
    ]) ||
    value.kind !== "takoserver.money-shadow-native-probe-review@v1" ||
    value.decision !== "approved" ||
    value.bindingDigest !== bindingDigest ||
    typeof value.evidencePath !== "string" ||
    !SHA.test(String(value.evidenceDigest)) ||
    moneyShadowHash(
      moneyShadowProtectedBytes(value.evidencePath, "independent native probe evidence"),
    ) !== value.evidenceDigest ||
    typeof value.reviewer !== "string" ||
    value.reviewer.trim() !== value.reviewer ||
    value.reviewer.length < 2 ||
    typeof value.reviewedAt !== "string" ||
    !/^20\d\d-\d\d-\d\dT/u.test(value.reviewedAt)
  )
    throw preflightError("shadow native probe independent review does not bind this phase");
  return moneyShadowHash(moneyShadowProtectedBytes(path, "shadow native probe independent review"));
}

function workerName(databaseName: string): string {
  return `${databaseName}-probe`;
}
function jsonHash(value: unknown): string {
  return moneyShadowHash(JSON.stringify(value));
}

function workerBindingDigest(input: {
  readonly declaration: MoneyShadowNativeProbeDeclaration;
  readonly sourceCommit: string;
  readonly writerEpoch: string;
  readonly authDigest: string;
  readonly authGenesisDigest: string;
  readonly applicationDigest: string;
}): string {
  return jsonHash({
    kind: "takoserver.money-shadow-native-worker-binding@v1",
    accountId: input.declaration.accountId,
    databaseId: input.declaration.databaseId,
    databaseName: input.declaration.databaseName,
    workerName: workerName(input.declaration.databaseName),
    rehearsalDeclarationDigest: input.declaration.rehearsalDeclarationDigest,
    sourceCommit: input.sourceCommit,
    writerEpoch: input.writerEpoch,
    authDigest: input.authDigest,
    authGenesisDigest: input.authGenesisDigest,
    applicationDigest: input.applicationDigest,
  });
}

function config(
  path: string,
  main: string,
  declaration: MoneyShadowNativeProbeDeclaration,
  commit: string,
  writerEpoch: string,
  revokedEpoch: string,
  bindingDigest: string,
): string {
  const body = {
    name: workerName(declaration.databaseName),
    main,
    account_id: declaration.accountId,
    compatibility_date: "2026-08-17",
    workers_dev: true,
    preview_urls: false,
    d1_databases: [
      {
        binding: "STATE_DB",
        database_name: declaration.databaseName,
        database_id: declaration.databaseId,
      },
    ],
    vars: {
      MONEY_SHADOW_WRITER_EPOCH: writerEpoch,
      MONEY_SHADOW_REVOKED_EPOCH: revokedEpoch,
      MONEY_SHADOW_BINDING_DIGEST: bindingDigest,
      MONEY_SHADOW_SOURCE_COMMIT: commit,
    },
  };
  writeFileSync(path, `${JSON.stringify(body, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  return path;
}

interface BuiltArtifact {
  readonly bundlePath: string;
  readonly configPath: string;
  readonly bundleDigest: string;
  readonly configDigest: string;
  assertUnchanged(): void;
}

async function buildArtifact(
  root: string,
  declaration: MoneyShadowNativeProbeDeclaration,
  commit: string,
  writerEpoch: string,
  revokedEpoch: string,
  bindingDigest: string,
  childEnvironment: Readonly<Record<string, string>>,
  run: typeof runCommand,
  wranglerPath: string,
): Promise<BuiltArtifact> {
  const build = join(root, "build");
  const release = join(root, "release");
  mkdirSync(build, { mode: 0o700 });
  mkdirSync(release, { mode: 0o700 });
  const source = resolve(REPOSITORY, "src/entry-money-shadow-native-probe.ts");
  const buildConfig = config(
    join(root, "build-wrangler.jsonc"),
    source,
    declaration,
    commit,
    writerEpoch,
    revokedEpoch,
    bindingDigest,
  );
  let built: Awaited<ReturnType<typeof runCommand>>;
  try {
    built = await run(
      [wranglerPath, "deploy", "--dry-run", "--strict", "--config", buildConfig, "--outdir", build],
      { env: childEnvironment },
    );
  } catch {
    throw preflightError("native probe Worker dry-run bundle is unavailable");
  }
  if (built.exitCode !== 0) throw preflightError("native probe Worker dry-run bundle failed");
  const entries = readdirSync(build).sort();
  const bundles = entries.filter((name) => name.endsWith(".js"));
  if (
    bundles.length !== 1 ||
    entries.some((name) => ![bundles[0], `${bundles[0]}.map`, "README.md"].includes(name))
  )
    throw preflightError("native probe Worker dry-run produced unexpected artifact files");
  const bundleSource = join(build, bundles[0] as string);
  if (!lstatSync(bundleSource).isFile() || lstatSync(bundleSource).isSymbolicLink())
    throw preflightError("native probe Worker bundle is not a regular file");
  const bundlePath = join(release, "worker.js");
  writeFileSync(
    bundlePath,
    canonicalizeWorkerBundleSource(readFileSync(bundleSource, "utf8"), bundleSource),
    { flag: "wx", mode: 0o600 },
  );
  const configPath = config(
    join(release, "wrangler.jsonc"),
    "worker.js",
    declaration,
    commit,
    writerEpoch,
    revokedEpoch,
    bindingDigest,
  );
  const sealed = sealDirectory(release, ["worker.js", "wrangler.jsonc"]);
  return {
    bundlePath,
    configPath,
    bundleDigest: moneyShadowHash(readFileSync(bundlePath)),
    configDigest: moneyShadowHash(readFileSync(configPath)),
    assertUnchanged: () => sealed.assertUnchanged(),
  };
}

/** Exact-name GET only; this lane never enumerates account-wide Worker scripts or routes. */
export async function readExactMoneyShadowProbeWorkerPresence(
  accountId: string,
  name: string,
  token: string,
  fetcher: (request: Request) => Promise<Response>,
): Promise<boolean> {
  let response: Response;
  try {
    response = await fetcher(
      new Request(
        `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${name}`,
        {
          method: "GET",
          redirect: "manual",
          headers: { authorization: `Bearer ${token}`, accept: "application/json" },
          signal: AbortSignal.timeout(15_000),
        },
      ),
    );
  } catch {
    throw preflightError("exact shadow Worker presence GET is unavailable");
  }
  if (response.redirected || (response.status >= 300 && response.status < 400))
    throw preflightError("exact shadow Worker GET redirected");
  if (response.status === 200) {
    try {
      await response.body?.cancel();
    } catch {
      throw preflightError("exact shadow Worker presence GET is unavailable");
    }
    return true;
  }
  if (response.status !== 404) throw preflightError("exact shadow Worker presence is unavailable");
  const body = await boundedResponseText(response, () =>
    preflightError("exact shadow Worker absence response is unavailable or exceeds bound"),
  );
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw preflightError("exact shadow Worker absence is malformed");
  }
  if (
    !record(parsed) ||
    parsed.success !== false ||
    parsed.result !== null ||
    !Array.isArray(parsed.errors) ||
    parsed.errors.length !== 1 ||
    !record(parsed.errors[0]) ||
    parsed.errors[0].code !== 10007
  )
    throw preflightError("exact shadow Worker absence was not authenticated by provider");
  return false;
}

async function boundedResponseText(response: Response, failure: () => Error): Promise<string> {
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > 4096) {
        await reader.cancel().catch(() => undefined);
        throw failure();
      }
      chunks.push(next.value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw failure();
  } finally {
    reader.releaseLock();
  }
}

async function nativeWorkerUntrusted(
  state: CloudflareState,
  declaration: MoneyShadowNativeProbeDeclaration,
  binding: ProbeBinding,
): Promise<NativeWorker> {
  const name = workerName(declaration.databaseName);
  const history = parseWorkerDeploymentHistory(await state.workerDeployments(name), "verification");
  if (
    history === null ||
    history.previousVersionId !== null ||
    !UUID.test(history.versionId) ||
    !UUID.test(history.deploymentId)
  )
    throw verificationError("shadow diagnostic Worker has no exact first 100 percent deployment");
  const version = await state.workerVersion(name, history.versionId);
  const identity = workerVersionIdentity("verification", version);
  if (
    identity.commit !== binding.sourceCommit ||
    `sha256:${identity.bundleDigestHex}` !== binding.bundleDigest
  )
    throw verificationError(
      "shadow diagnostic Worker Version has foreign source or bundle annotation",
    );
  const moduleDigest = `sha256:${exactV2MaintenanceModuleDigest("verification", await state.workerVersionWithModules(name, history.versionId))}`;
  if (moduleDigest !== binding.bundleDigest)
    throw verificationError("shadow diagnostic Worker native module differs from sealed bundle");
  assertExactVersionBindingClosure("verification", history.versionId, version, {
    STATE_DB: { type: "d1", fields: { id: declaration.databaseId } },
    MONEY_SHADOW_WRITER_EPOCH: { type: "plain_text", fields: { text: binding.writerEpoch } },
    MONEY_SHADOW_REVOKED_EPOCH: { type: "plain_text", fields: { text: binding.revokedEpoch } },
    MONEY_SHADOW_BINDING_DIGEST: {
      type: "plain_text",
      fields: { text: binding.workerBindingDigest },
    },
    MONEY_SHADOW_SOURCE_COMMIT: { type: "plain_text", fields: { text: binding.sourceCommit } },
    [AUTH_NAME]: { type: "secret_text", fields: {} },
  });
  assertExactSecretInventory(await state.workerSecrets(name), [AUTH_NAME], "verification");
  if ((await state.workerSchedules(name)).length !== 0)
    throw verificationError("shadow diagnostic Worker unexpectedly has a cron schedule");
  const subdomain = await state.workerSubdomain(name);
  const accountSubdomain = await state.workerAccountSubdomain();
  if (
    !subdomain.enabled ||
    subdomain.previewsEnabled ||
    !/^[a-z0-9][a-z0-9-]{0,62}$/u.test(accountSubdomain)
  )
    throw verificationError("shadow diagnostic Worker has unexpected Workers.dev routing");
  const after = parseWorkerDeploymentHistory(await state.workerDeployments(name), "verification");
  if (
    after?.deploymentId !== history.deploymentId ||
    after.versionId !== history.versionId ||
    after.previousVersionId !== null
  )
    throw verificationError("shadow diagnostic Worker changed during native readback");
  return {
    versionId: history.versionId,
    deploymentId: history.deploymentId,
    moduleDigest,
    endpoint: `https://${name}.${accountSubdomain}.workers.dev`,
  };
}

async function nativeWorker(
  state: CloudflareState,
  declaration: MoneyShadowNativeProbeDeclaration,
  binding: ProbeBinding,
): Promise<NativeWorker> {
  try {
    return await nativeWorkerUntrusted(state, declaration, binding);
  } catch {
    // CloudflareState and binding-closure helpers can include provider values
    // or malformed binding nodes in DeployError.detail. This surface never
    // allows those details through its CLI boundary.
    throw verificationError("shadow diagnostic Worker native readback is unavailable or divergent");
  }
}

/** Exposed for local refusal tests; the normal surface always supplies its selected owner state. */
export { nativeWorker as readMoneyShadowProbeNativeWorker };

export async function readMoneyShadowProbeWorkerStatus(
  endpoint: string,
  secret: string,
  fetcher: (request: Request) => Promise<Response>,
): Promise<ProbeStatus> {
  let response: Response;
  try {
    response = await fetcher(
      new Request(`${endpoint}/status`, {
        method: "GET",
        redirect: "manual",
        headers: { authorization: `Bearer ${secret}`, accept: "application/json" },
        signal: AbortSignal.timeout(15_000),
      }),
    );
  } catch {
    throw verificationError("shadow diagnostic Worker GET status is unavailable");
  }
  if (response.status !== 200 || response.redirected)
    throw verificationError("shadow diagnostic Worker GET status did not return exact success");
  const body = await boundedResponseText(response, () =>
    verificationError("shadow diagnostic Worker status is unavailable or exceeds bound"),
  );
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    throw verificationError("shadow diagnostic Worker status is malformed");
  }
  if (
    !record(value) ||
    !sameKeys(value, [
      "state",
      "bindingDigest",
      "sourceCommit",
      "resultDigest",
      "completeReadbackMatches",
      "permitEmpty",
      "writerEpochMatches",
    ]) ||
    !["absent", "started", "complete", "failed"].includes(String(value.state)) ||
    !SHA.test(String(value.bindingDigest)) ||
    !COMMIT.test(String(value.sourceCommit)) ||
    (value.resultDigest !== null && !SHA.test(String(value.resultDigest))) ||
    (value.completeReadbackMatches !== null &&
      typeof value.completeReadbackMatches !== "boolean") ||
    typeof value.permitEmpty !== "boolean" ||
    typeof value.writerEpochMatches !== "boolean"
  )
    throw verificationError("shadow diagnostic Worker status has foreign shape");
  return value as unknown as ProbeStatus;
}

function assertPublishedWorkerStatus(
  status: ProbeStatus,
  binding: ProbeBinding,
  requireAbsentJournal: boolean,
): void {
  if (
    status.bindingDigest !== binding.workerBindingDigest ||
    status.sourceCommit !== binding.sourceCommit ||
    !status.permitEmpty ||
    !status.writerEpochMatches ||
    (requireAbsentJournal &&
      (status.state !== "absent" ||
        status.resultDigest !== null ||
        status.completeReadbackMatches !== null))
  )
    throw verificationError("published Worker GET status or native guard differs");
}

async function postProbeOnce(
  endpoint: string,
  secret: string,
  fetcher: (request: Request) => Promise<Response>,
): Promise<{ readonly bindingDigest: string; readonly resultDigest: string }> {
  let response: Response;
  try {
    response = await fetcher(
      new Request(`${endpoint}/run`, {
        method: "POST",
        redirect: "manual",
        headers: { authorization: `Bearer ${secret}`, accept: "application/json" },
        signal: AbortSignal.timeout(30_000),
      }),
    );
  } catch {
    throw mutationError(
      "shadow diagnostic POST acknowledgement unknown; GET status only, never retry",
    );
  }
  if (response.status !== 200 || response.redirected)
    throw mutationError(
      "shadow diagnostic POST did not acknowledge exact success; GET status only, never retry",
    );
  const body = await boundedResponseText(response, () =>
    mutationError(
      "shadow diagnostic POST acknowledgement unavailable or exceeds bound; GET status only",
    ),
  );
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    throw mutationError("shadow diagnostic POST acknowledgement malformed; GET status only");
  }
  if (
    !record(value) ||
    !sameKeys(value, ["state", "bindingDigest", "resultDigest"]) ||
    value.state !== "complete" ||
    !SHA.test(String(value.bindingDigest)) ||
    !SHA.test(String(value.resultDigest))
  )
    throw mutationError("shadow diagnostic POST acknowledgement divergent; GET status only");
  return {
    bindingDigest: value.bindingDigest as string,
    resultDigest: value.resultDigest as string,
  };
}

function readDispatch(
  path: string,
  phase: "publish" | "probe",
): {
  readonly binding: ProbeBinding;
  readonly bindingDigest: string;
  readonly reviewDigest: string;
  readonly artifactRoot?: string;
} | null {
  if (!existsSync(path)) return null;
  const value = readProtectedJson(path, "shadow native probe dispatch");
  if (
    !sameKeys(
      value,
      phase === "publish"
        ? ["kind", "binding", "bindingDigest", "reviewDigest", "artifactRoot"]
        : ["kind", "binding", "bindingDigest", "reviewDigest"],
    ) ||
    value.kind !== "takoserver.money-shadow-native-probe-dispatch@v1" ||
    !record(value.binding) ||
    !sameKeys(value.binding, [
      "kind",
      "phase",
      "accountId",
      "databaseName",
      "databaseId",
      "workerName",
      "sourceCommit",
      "rehearsalSourceCommit",
      "rehearsalDeclarationDigest",
      "rehearsalApplicationDigest",
      "rehearsalFinancialDigest",
      "rehearsalShapeDigest",
      "writerEpoch",
      "revokedEpoch",
      "authDigest",
      "authGenesisDigest",
      "workerBindingDigest",
      "bundleDigest",
      "configDigest",
      ...(phase === "probe"
        ? [
            "publicationTerminalDigest",
            "nativeVersionId",
            "nativeDeploymentId",
            "nativeStatusDigest",
          ]
        : []),
    ]) ||
    value.binding.kind !== "takoserver.money-shadow-native-probe-binding@v1" ||
    value.binding.phase !== phase ||
    !ACCOUNT.test(String(value.binding.accountId)) ||
    !NAME.test(String(value.binding.databaseName)) ||
    !UUID.test(String(value.binding.databaseId)) ||
    value.binding.workerName !== workerName(String(value.binding.databaseName)) ||
    !COMMIT.test(String(value.binding.sourceCommit)) ||
    !COMMIT.test(String(value.binding.rehearsalSourceCommit)) ||
    ![
      "rehearsalDeclarationDigest",
      "rehearsalApplicationDigest",
      "rehearsalFinancialDigest",
      "rehearsalShapeDigest",
      "writerEpoch",
      "revokedEpoch",
      "authDigest",
      "authGenesisDigest",
      "workerBindingDigest",
      "bundleDigest",
      "configDigest",
      ...(phase === "probe" ? ["publicationTerminalDigest", "nativeStatusDigest"] : []),
    ].every((key) => SHA.test(String((value.binding as Record<string, unknown>)[key]))) ||
    (phase === "probe" &&
      (!UUID.test(String(value.binding.nativeVersionId)) ||
        !UUID.test(String(value.binding.nativeDeploymentId)))) ||
    !SHA.test(String(value.bindingDigest)) ||
    jsonHash(value.binding) !== value.bindingDigest ||
    !SHA.test(String(value.reviewDigest))
  )
    throw mutationError("shadow native probe retained dispatch is malformed");
  if (phase === "publish") {
    const root = value.artifactRoot;
    if (
      typeof root !== "string" ||
      !/^native-probe-artifact-[A-Za-z0-9]+$/u.test(relative(dirname(path), root))
    )
      throw mutationError("shadow native probe retained artifact root is foreign");
    moneyShadowProtectedDirectory(root);
    const bundle = moneyShadowProtectedBytes(
      join(root, "release", "worker.js"),
      "retained shadow diagnostic Worker bundle",
    );
    const configBytes = moneyShadowProtectedBytes(
      join(root, "release", "wrangler.jsonc"),
      "retained shadow diagnostic Worker config",
    );
    if (
      moneyShadowHash(bundle) !== value.binding.bundleDigest ||
      moneyShadowHash(configBytes) !== value.binding.configDigest
    )
      throw mutationError("shadow native probe retained artifact bytes changed");
  }
  return value as unknown as {
    readonly binding: ProbeBinding;
    readonly bindingDigest: string;
    readonly reviewDigest: string;
    readonly artifactRoot?: string;
  };
}

function assertRetainedBinding(
  declaration: MoneyShadowNativeProbeDeclaration,
  invocation: MoneyShadowNativeProbeInvocation,
  selectedAuthDigest: string,
  selectedAuthGenesisDigest: string,
  binding: ProbeBinding,
): void {
  if (
    binding.accountId !== declaration.accountId ||
    binding.databaseName !== declaration.databaseName ||
    binding.databaseId !== declaration.databaseId ||
    binding.workerName !== workerName(declaration.databaseName) ||
    binding.sourceCommit !== invocation.commit ||
    binding.rehearsalSourceCommit !== declaration.rehearsalSourceCommit ||
    binding.rehearsalDeclarationDigest !== declaration.rehearsalDeclarationDigest ||
    binding.authDigest !== selectedAuthDigest ||
    binding.authGenesisDigest !== selectedAuthGenesisDigest ||
    binding.revokedEpoch !==
      moneyShadowHash(`revoked-synthetic-rehearsal:${binding.writerEpoch}`) ||
    binding.workerBindingDigest !==
      workerBindingDigest({
        declaration,
        sourceCommit: invocation.commit,
        writerEpoch: binding.writerEpoch,
        authDigest: selectedAuthDigest,
        authGenesisDigest: selectedAuthGenesisDigest,
        applicationDigest: binding.rehearsalApplicationDigest,
      })
  )
    throw mutationError("retained native probe dispatch selects changed owner authority");
}

function readTerminal(path: string, bindingDigest: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  const value = readProtectedJson(path, "shadow native probe terminal");
  if (
    !sameKeys(value, [
      "kind",
      "phase",
      "bindingDigest",
      "accountId",
      "databaseId",
      "workerName",
      "versionId",
      "deploymentId",
      "nativeResultDigest",
    ]) ||
    value.kind !== "takoserver.money-shadow-native-probe-terminal@v1" ||
    value.bindingDigest !== bindingDigest ||
    !SHA.test(String(value.nativeResultDigest))
  )
    throw verificationError("shadow native probe terminal custody is malformed");
  return value;
}

async function terminalRehearsal(
  declaration: MoneyShadowNativeProbeDeclaration,
  source: IntegrationMoneyShadowRehearsalDeclaration,
  options: MoneyShadowNativeProbeOptions,
): Promise<{
  readonly applicationDigest: string;
  readonly financialDigest: string;
  readonly shapeDigest: string;
  readonly writerEpoch: string;
}> {
  let status: Awaited<ReturnType<typeof runIntegrationMoneyShadowRehearsal>>;
  try {
    status = await runIntegrationMoneyShadowRehearsal(
      source,
      {
        action: "status",
        environment: "integration",
        commit: declaration.rehearsalSourceCommit,
      },
      {
        ...(options.run === undefined ? {} : { run: options.run }),
        ...(options.cloudflareEnvironment === undefined
          ? {}
          : { cloudflareEnvironment: options.cloudflareEnvironment }),
      },
    );
  } catch {
    throw preflightError(
      "terminal synthetic rehearsal native readback is unavailable or divergent",
    );
  }
  if (
    status.custody !== "terminal" ||
    status.exactAfter !== true ||
    !SHA.test(String(status.applicationDigest)) ||
    !SHA.test(String(status.financialDigest)) ||
    !SHA.test(String(status.schemaShapeDigest)) ||
    status.workerD1BatchProven !== false
  )
    throw preflightError(
      "native probe requires exact terminal permit-success shadow rehearsal readback",
    );
  const files = readMigrationArtifact().files;
  const plan = await buildMoneyRehearsalSyntheticPlan(files, source);
  if (
    status.applicationDigest !== plan.application["permit-success"] ||
    status.financialDigest !== plan.financial["permit-success"]
  )
    throw preflightError(
      "native probe rehearsal row readback differs from sealed synthetic fixture",
    );
  return {
    applicationDigest: status.applicationDigest as string,
    financialDigest: status.financialDigest as string,
    shapeDigest: status.schemaShapeDigest as string,
    writerEpoch: plan.writerEpoch,
  };
}

function statusEnvelope(
  declaration: MoneyShadowNativeProbeDeclaration,
  binding: ProbeBinding,
  reviewDigest: string | null,
  custody: "none" | "dispatched" | "terminal",
  native: NativeWorker | null,
  observed: ProbeStatus | null,
): Record<string, unknown> {
  return {
    kind: "takoserver.money-shadow-native-probe-status@v1",
    surface: SURFACE,
    environment: "integration",
    phase: declaration.phase,
    accountId: declaration.accountId,
    databaseId: declaration.databaseId,
    workerName: workerName(declaration.databaseName),
    binding,
    bindingDigest: jsonHash(binding),
    reviewDigest,
    custody,
    nativeVersionId: native?.versionId ?? null,
    nativeDeploymentId: native?.deploymentId ?? null,
    probeState: observed?.state ?? null,
    nativeBatchProven:
      declaration.phase === "probe" &&
      custody === "terminal" &&
      observed?.state === "complete" &&
      observed.completeReadbackMatches === true,
    readyForApply:
      custody === "none" &&
      reviewDigest !== null &&
      (declaration.phase === "publish" ? native === null : observed?.state === "absent"),
    grantsExistingBillingD1Apply: false,
  };
}

/** Only the fresh synthetic shadow D1 and its exact diagnostic Worker are addressable. */
export async function runIntegrationMoneyShadowNativeProbe(
  declaration: MoneyShadowNativeProbeDeclaration,
  invocation: MoneyShadowNativeProbeInvocation,
  options: MoneyShadowNativeProbeOptions = {},
): Promise<Record<string, unknown>> {
  validateDeclaration(declaration);
  if (
    invocation.environment !== "integration" ||
    !COMMIT.test(invocation.commit) ||
    !["status", "apply"].includes(invocation.action)
  )
    throw preflightError(
      "shadow native probe accepts exact integration status/apply and commit only",
    );
  const rehearsal = exactRehearsalDeclaration(declaration);
  const run = options.run ?? runCommand;
  const fetcher = options.fetcher ?? ((request: Request) => fetch(request));
  const credential = await resolveCloudflareCredential("integration", {
    ...(options.run === undefined ? {} : { run: options.run }),
    ...(options.cloudflareEnvironment === undefined
      ? {}
      : { cloudflareEnvironment: options.cloudflareEnvironment }),
    ...(options.wranglerPath === undefined ? {} : { wranglerPath: options.wranglerPath }),
  });
  if (credential.source !== "oauth" || "CLOUDFLARE_API_TOKEN" in credential.childEnvironment)
    throw preflightError("shadow native probe requires canonical integration Wrangler OAuth");
  const authValue = await auth(declaration, invocation, credential.token, fetcher, run);
  const state =
    options.state ??
    new CloudflareState({ accountId: declaration.accountId, token: credential.token, fetcher });
  const name = workerName(declaration.databaseName);
  const dispatchPath = join(declaration.custodyDirectory, `${declaration.phase}.dispatched.json`);
  const terminalPath = join(declaration.custodyDirectory, `${declaration.phase}.terminal.json`);
  const dispatch = readDispatch(dispatchPath, declaration.phase);
  if (dispatch !== null)
    assertRetainedBinding(
      declaration,
      invocation,
      authValue.digest,
      authValue.genesisDigest,
      dispatch.binding,
    );
  if (dispatch === null && existsSync(terminalPath))
    throw verificationError("shadow native probe terminal exists without immutable dispatch");
  const retainedTerminal =
    dispatch === null ? null : readTerminal(terminalPath, dispatch.bindingDigest);
  if (
    retainedTerminal !== null &&
    (retainedTerminal.phase !== declaration.phase ||
      retainedTerminal.accountId !== declaration.accountId ||
      retainedTerminal.databaseId !== declaration.databaseId ||
      retainedTerminal.workerName !== name ||
      !UUID.test(String(retainedTerminal.versionId)) ||
      !UUID.test(String(retainedTerminal.deploymentId)))
  )
    throw verificationError("shadow native probe terminal selects a foreign identity");
  if (invocation.action === "apply" && dispatch !== null)
    throw mutationError(
      "shadow native probe phase already dispatched; GET-only status, never retry",
    );

  if (declaration.phase === "probe") {
    const publicationPath = join(declaration.custodyDirectory, "publish.terminal.json");
    const publication = readProtectedJson(
      publicationPath,
      "shadow diagnostic Worker publication terminal",
    );
    const publicationDispatch = readDispatch(
      join(declaration.custodyDirectory, "publish.dispatched.json"),
      "publish",
    );
    if (publicationDispatch !== null)
      assertRetainedBinding(
        declaration,
        invocation,
        authValue.digest,
        authValue.genesisDigest,
        publicationDispatch.binding,
      );
    if (
      publicationDispatch === null ||
      publication.kind !== "takoserver.money-shadow-native-probe-terminal@v1" ||
      publication.bindingDigest !== publicationDispatch.bindingDigest ||
      publication.phase !== "publish" ||
      publication.accountId !== declaration.accountId ||
      publication.databaseId !== declaration.databaseId ||
      publication.workerName !== name ||
      !SHA.test(String(publication.nativeResultDigest))
    )
      throw preflightError(
        "probe requires exact no-overwrite diagnostic Worker publication terminal",
      );
    const publicationDigest = moneyShadowHash(
      moneyShadowProtectedBytes(publicationPath, "shadow Worker publication terminal"),
    );
    const published = publicationDispatch.binding;
    if (
      published.sourceCommit !== invocation.commit ||
      published.authDigest !== authValue.digest ||
      published.rehearsalDeclarationDigest !== declaration.rehearsalDeclarationDigest
    )
      throw preflightError("probe declaration differs from published Worker source or auth");
    const native = await nativeWorker(state, declaration, published);
    if (
      native.versionId !== publication.versionId ||
      native.deploymentId !== publication.deploymentId ||
      native.moduleDigest !== publication.nativeResultDigest
    )
      throw verificationError("published diagnostic Worker changed before probe");
    const observed = await readMoneyShadowProbeWorkerStatus(
      native.endpoint,
      authValue.secret,
      fetcher,
    );
    if (
      observed.bindingDigest !== published.workerBindingDigest ||
      observed.sourceCommit !== invocation.commit ||
      !observed.permitEmpty ||
      !observed.writerEpochMatches
    )
      throw verificationError("diagnostic Worker GET differs from sealed publication or guard");
    if (dispatch !== null) {
      const binding = dispatch.binding;
      if (
        binding.phase !== "probe" ||
        binding.publicationTerminalDigest !== publicationDigest ||
        binding.nativeVersionId !== native.versionId ||
        binding.nativeDeploymentId !== native.deploymentId ||
        binding.authDigest !== authValue.digest ||
        binding.workerBindingDigest !== published.workerBindingDigest ||
        binding.bundleDigest !== published.bundleDigest ||
        binding.configDigest !== published.configDigest ||
        binding.rehearsalApplicationDigest !== published.rehearsalApplicationDigest ||
        binding.rehearsalFinancialDigest !== published.rehearsalFinancialDigest
      )
        throw mutationError("retained native probe dispatch differs from publication");
      if (
        observed.state === "complete" &&
        observed.completeReadbackMatches === true &&
        observed.resultDigest !== null
      ) {
        const readNative = () => nativeWorker(state, declaration, published);
        if (
          retainedTerminal !== null &&
          retainedTerminal.nativeResultDigest !== observed.resultDigest
        )
          throw verificationError("native probe terminal differs from Worker GET readback");
        if (retainedTerminal === null)
          await terminalizeMoneyShadowProbeAfterNativeRefence({
            terminalPath,
            declaration,
            bindingDigest: dispatch.bindingDigest,
            expectedNative: native,
            resultDigest: observed.resultDigest,
            readNative,
          });
        else assertMoneyShadowProbeNativeRefence(native, await readNative());
        return statusEnvelope(
          declaration,
          binding,
          dispatch.reviewDigest,
          "terminal",
          native,
          observed,
        );
      }
      return statusEnvelope(
        declaration,
        binding,
        dispatch.reviewDigest,
        "dispatched",
        native,
        observed,
      );
    }
    if (
      observed.state !== "absent" ||
      observed.completeReadbackMatches !== null ||
      observed.resultDigest !== null
    )
      throw preflightError("unowned shadow Worker journal state cannot be adopted");
    const terminal = await terminalRehearsal(declaration, rehearsal, options);
    if (
      terminal.writerEpoch !== published.writerEpoch ||
      terminal.applicationDigest !== published.rehearsalApplicationDigest ||
      terminal.financialDigest !== published.rehearsalFinancialDigest ||
      terminal.shapeDigest !== published.rehearsalShapeDigest
    )
      throw preflightError("synthetic shadow D1 changed after Worker publication");
    const binding: ProbeBinding = {
      ...published,
      kind: "takoserver.money-shadow-native-probe-binding@v1",
      phase: "probe",
      publicationTerminalDigest: publicationDigest,
      nativeVersionId: native.versionId,
      nativeDeploymentId: native.deploymentId,
      nativeStatusDigest: jsonHash(observed),
    };
    const bindingDigest = jsonHash(binding);
    const reviewDigest = readReview(declaration.reviewPath, bindingDigest);
    if (invocation.action === "status")
      return statusEnvelope(declaration, binding, reviewDigest, "none", native, observed);
    if (reviewDigest === null)
      throw preflightError(
        "native Worker batch probe requires binding-specific independent review",
      );
    await qualifySource({
      environment: "integration",
      commit: invocation.commit,
      policy: "clean-remote",
      run,
    });
    const before = await readMoneyShadowProbeWorkerStatus(
      native.endpoint,
      authValue.secret,
      fetcher,
    );
    if (
      jsonHash(before) !== binding.nativeStatusDigest ||
      (await nativeWorker(state, declaration, published)).deploymentId !== native.deploymentId
    )
      throw preflightError("native Worker or one-use journal changed before probe dispatch");
    moneyShadowWriteOnce(
      dispatchPath,
      `${JSON.stringify({ kind: "takoserver.money-shadow-native-probe-dispatch@v1", binding, bindingDigest, reviewDigest })}\n`,
    );
    const acknowledgement = await postProbeOnce(native.endpoint, authValue.secret, fetcher);
    const after = await readMoneyShadowProbeWorkerStatus(
      native.endpoint,
      authValue.secret,
      fetcher,
    );
    if (
      after.state !== "complete" ||
      after.completeReadbackMatches !== true ||
      after.resultDigest === null ||
      after.bindingDigest !== binding.workerBindingDigest ||
      acknowledgement.bindingDigest !== after.bindingDigest ||
      acknowledgement.resultDigest !== after.resultDigest ||
      !after.permitEmpty ||
      !after.writerEpochMatches
    )
      throw verificationError("native Worker batch probe POST lacks exact GET readback; no retry");
    await terminalizeMoneyShadowProbeAfterNativeRefence({
      terminalPath,
      declaration,
      bindingDigest,
      expectedNative: native,
      resultDigest: after.resultDigest,
      readNative: () => nativeWorker(state, declaration, published),
    });
    return statusEnvelope(declaration, binding, reviewDigest, "terminal", native, after);
  }

  // A publication has one fresh name and one immutable first Version. A prior
  // dispatch can only be reconciled through native GETs; it never re-uploads.
  if (dispatch !== null && retainedTerminal !== null) {
    const native = await nativeWorker(state, declaration, dispatch.binding);
    if (
      native.moduleDigest !== retainedTerminal.nativeResultDigest ||
      native.versionId !== retainedTerminal.versionId ||
      native.deploymentId !== retainedTerminal.deploymentId
    )
      throw verificationError(
        "shadow diagnostic Worker publication terminal differs from native GET",
      );
    const observed = await readMoneyShadowProbeWorkerStatus(
      native.endpoint,
      authValue.secret,
      fetcher,
    );
    assertPublishedWorkerStatus(observed, dispatch.binding, false);
    return statusEnvelope(
      declaration,
      dispatch.binding,
      dispatch.reviewDigest,
      "terminal",
      native,
      observed,
    );
  }
  if (dispatch !== null) {
    const native = await nativeWorker(state, declaration, dispatch.binding);
    const observed = await readMoneyShadowProbeWorkerStatus(
      native.endpoint,
      authValue.secret,
      fetcher,
    );
    assertPublishedWorkerStatus(observed, dispatch.binding, true);
    moneyShadowWriteOnce(
      terminalPath,
      `${JSON.stringify({
        kind: "takoserver.money-shadow-native-probe-terminal@v1",
        phase: "publish",
        bindingDigest: dispatch.bindingDigest,
        accountId: declaration.accountId,
        databaseId: declaration.databaseId,
        workerName: name,
        versionId: native.versionId,
        deploymentId: native.deploymentId,
        nativeResultDigest: native.moduleDigest,
      })}\n`,
    );
    return statusEnvelope(
      declaration,
      dispatch.binding,
      dispatch.reviewDigest,
      "terminal",
      native,
      observed,
    );
  }
  if (
    await readExactMoneyShadowProbeWorkerPresence(
      declaration.accountId,
      name,
      credential.token,
      fetcher,
    )
  )
    throw preflightError("exact shadow diagnostic Worker name already exists; no adoption");
  const terminal = await terminalRehearsal(declaration, rehearsal, options);
  const revokedEpoch = moneyShadowHash(`revoked-synthetic-rehearsal:${terminal.writerEpoch}`);
  const bindingDigestForWorker = workerBindingDigest({
    declaration,
    sourceCommit: invocation.commit,
    writerEpoch: terminal.writerEpoch,
    authDigest: authValue.digest,
    authGenesisDigest: authValue.genesisDigest,
    applicationDigest: terminal.applicationDigest,
  });
  await qualifySource({
    environment: "integration",
    commit: invocation.commit,
    policy: "clean-remote",
    run,
  });
  const root = mkdtempSync(join(declaration.custodyDirectory, "native-probe-artifact-"));
  let dispatched = false;
  try {
    const artifact = await buildArtifact(
      root,
      declaration,
      invocation.commit,
      terminal.writerEpoch,
      revokedEpoch,
      bindingDigestForWorker,
      credential.childEnvironment,
      run,
      options.wranglerPath ?? WRANGLER,
    );
    const binding: ProbeBinding = {
      kind: "takoserver.money-shadow-native-probe-binding@v1",
      phase: "publish",
      accountId: declaration.accountId,
      databaseName: declaration.databaseName,
      databaseId: declaration.databaseId,
      workerName: name,
      sourceCommit: invocation.commit,
      rehearsalSourceCommit: declaration.rehearsalSourceCommit,
      rehearsalDeclarationDigest: declaration.rehearsalDeclarationDigest,
      rehearsalApplicationDigest: terminal.applicationDigest,
      rehearsalFinancialDigest: terminal.financialDigest,
      rehearsalShapeDigest: terminal.shapeDigest,
      writerEpoch: terminal.writerEpoch,
      revokedEpoch,
      authDigest: authValue.digest,
      authGenesisDigest: authValue.genesisDigest,
      workerBindingDigest: bindingDigestForWorker,
      bundleDigest: artifact.bundleDigest,
      configDigest: artifact.configDigest,
    };
    const bindingDigest = jsonHash(binding);
    const reviewDigest = readReview(declaration.reviewPath, bindingDigest);
    if (invocation.action === "status")
      return statusEnvelope(declaration, binding, reviewDigest, "none", null, null);
    if (reviewDigest === null)
      throw preflightError(
        "diagnostic Worker publication requires binding-specific independent review",
      );
    if (
      await readExactMoneyShadowProbeWorkerPresence(
        declaration.accountId,
        name,
        credential.token,
        fetcher,
      )
    )
      throw preflightError("diagnostic Worker name appeared before publication dispatch");
    const reread = await terminalRehearsal(declaration, rehearsal, options);
    if (
      JSON.stringify(reread) !== JSON.stringify(terminal) ||
      (await auth(declaration, { ...invocation, action: "apply" }, credential.token, fetcher, run))
        .genesisDigest !== authValue.genesisDigest ||
      readReview(declaration.reviewPath, bindingDigest) !== reviewDigest
    )
      throw preflightError("shadow rehearsal, auth or review changed before publication");
    await qualifySource({
      environment: "integration",
      commit: invocation.commit,
      policy: "clean-remote",
      run,
    });
    artifact.assertUnchanged();
    const secretsPath = join(root, "secrets.json");
    writeFileSync(secretsPath, `${JSON.stringify({ [AUTH_NAME]: authValue.secret })}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    const lease = await acquireWranglerVersionPublicationLease({
      accountId: declaration.accountId,
      workerName: name,
    });
    try {
      moneyShadowWriteOnce(
        dispatchPath,
        `${JSON.stringify({ kind: "takoserver.money-shadow-native-probe-dispatch@v1", binding, bindingDigest, reviewDigest, artifactRoot: root })}\n`,
      );
      dispatched = true;
      let published: Awaited<ReturnType<typeof deployWranglerLifecycleChange>>;
      try {
        published = await deployWranglerLifecycleChange({
          root,
          bundlePath: artifact.bundlePath,
          configPath: artifact.configPath,
          accountId: declaration.accountId,
          workerName: name,
          message: `takoserver-worker:${invocation.commit}:${artifact.bundleDigest.slice(7)}`,
          lease,
          secretsFilePath: secretsPath,
          environment: credential.childEnvironment,
          run,
          ...(options.wranglerPath === undefined ? {} : { wranglerPath: options.wranglerPath }),
          assertCurrentStillExpected: async () => {
            artifact.assertUnchanged();
            if (
              await readExactMoneyShadowProbeWorkerPresence(
                declaration.accountId,
                name,
                credential.token,
                fetcher,
              )
            )
              throw preflightError("shadow diagnostic Worker appeared before first deploy");
          },
        });
      } catch {
        throw mutationError(
          "shadow diagnostic Worker publication acknowledgement unknown; GET-only status, never retry",
        );
      }
      const native = await nativeWorker(state, declaration, binding);
      if (native.versionId !== published.versionId)
        throw verificationError(
          "shadow diagnostic Worker native Version differs from deploy acknowledgement",
        );
    } finally {
      await lease.release();
      rmSync(secretsPath, { force: true });
    }
    const native = await nativeWorker(state, declaration, binding);
    const observed = await readMoneyShadowProbeWorkerStatus(
      native.endpoint,
      authValue.secret,
      fetcher,
    );
    assertPublishedWorkerStatus(observed, binding, true);
    moneyShadowWriteOnce(
      terminalPath,
      `${JSON.stringify({
        kind: "takoserver.money-shadow-native-probe-terminal@v1",
        phase: "publish",
        bindingDigest,
        accountId: declaration.accountId,
        databaseId: declaration.databaseId,
        workerName: name,
        versionId: native.versionId,
        deploymentId: native.deploymentId,
        nativeResultDigest: native.moduleDigest,
      })}\n`,
    );
    return statusEnvelope(declaration, binding, reviewDigest, "terminal", native, observed);
  } finally {
    if (!dispatched) removeArtifactTree(root);
  }
}
