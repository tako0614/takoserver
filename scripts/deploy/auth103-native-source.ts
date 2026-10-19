import { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AUTH103_NATIVE_CATALOG_QUERY,
  AUTH103_NATIVE_DEFINE,
  AUTH103_NATIVE_PROFILE,
  AUTH103_NATIVE_PROFILE_DEFINE,
  AUTH103_NATIVE_REGISTRATION_QUERY,
  type Auth103NativeSourceManifest,
  auth103RpRegistrationRecord,
} from "../../src/auth103-native-source-contract.ts";
import { canonicalJson } from "../../src/json.ts";
import { SHARED_AUTH_STAGING_PROFILE } from "../../src/shared-auth-oidc-client.ts";
import { frameHostMigrationSql } from "../../src/sqlite-migration-policy.ts";
import { readAuth103CanonicalMigrationSource } from "./auth103-canonical-migration-source.ts";
import { createAuth103CanonicalSourceArtifacts } from "./auth103-canonical-recipes.ts";
import { preflightError } from "./errors.ts";
import {
  inspectMoneyNativeBuildDependencyTree,
  inspectMoneyNativeBuildSourceTree,
} from "./money-native-build-closure.ts";
import { type DeployProcess, REPOSITORY, runCommand, WRANGLER } from "./process.ts";
import type { DeployTarget } from "./target.ts";

export { createAuth103CanonicalSourceArtifacts } from "./auth103-canonical-recipes.ts";

const clockPath = "src/auth103-source-clock.ts";
const requiredSourcePaths = Object.freeze([
  clockPath,
  "src/auth103-native-origin-source.ts",
  "src/auth103-native-source-contract.ts",
  "src/auth103-native-platform-origin.ts",
  "src/entry-cloudflare-worker.ts",
  "src/worker-request-composition.ts",
  "src/auth-authority-schema-plan.ts",
  "src/auth-principal-schema-plan.ts",
  "src/auth-rp-storage-schema-plan.ts",
  "src/takoform-v2/container-owner-schema.ts",
  "src/takoform-v2/worker-native-identity-schema.ts",
  "scripts/deploy/v2-container-owner-migration-candidate.ts",
  "scripts/deploy/v2-worker-native-identity-migration-candidate.ts",
  "scripts/deploy/auth103-canonical-recipes.ts",
  "scripts/deploy/auth103-canonical-migration-source.ts",
  "scripts/deploy/auth103-native-source.ts",
  "src/shared-auth-oidc-client.ts",
  "src/shared-auth-session.ts",
  "src/worker-request-shared-principal-issuance.ts",
]);
const digest = (value: string | Uint8Array): `sha256:${string}` =>
  `sha256:${createHash("sha256").update(value).digest("hex")}`;
const dataDigest = (value: unknown): `sha256:${string}` => digest(canonicalJson(value));
const literal = (value: string): string => `'${value.replaceAll("'", "''")}'`;
function source(root: string, path: string): string {
  const file = resolve(root, path);
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
    throw preflightError("Auth103 source requires an owned regular file");
  return readFileSync(file, "utf8");
}
function assertExactCheckout(root: string, commit: string): void {
  const options = { encoding: "utf8" as const, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } };
  const head = spawnSync("git", ["-C", root, "rev-parse", "HEAD"], options);
  const status = spawnSync(
    "git",
    ["-C", root, "status", "--porcelain", "--untracked-files=all"],
    options,
  );
  if (
    head.status !== 0 ||
    head.signal !== null ||
    head.stdout.trim() !== commit ||
    status.status !== 0 ||
    status.signal !== null ||
    status.stdout !== ""
  )
    throw preflightError("Auth103 source qualification requires its unchanged exact checkout");
}
function exactGitSource(root: string, commit: string, path: string): string {
  const bytes = source(root, path);
  const result = spawnSync("git", ["-C", root, "show", `${commit}:${path}`], {
    encoding: "buffer",
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.status !== 0 || result.signal !== null || !Buffer.from(bytes).equals(result.stdout))
    throw preflightError("Auth103 build source differs from its exact commit");
  return bytes;
}

/**
 * Local source compiler only. Every original source is trigger-safely framed,
 * and EVERY statement is stepped separately inside that source's transaction.
 * Do not replace this with Database.exec(multiSQL): a non-final error must stop.
 * Raw source/query/error bodies never leave this compiler.
 */
function compileCatalog(sources: readonly string[]) {
  const database = new Database(":memory:", { strict: true });
  try {
    database.query("PRAGMA foreign_keys = ON").all();
    for (const sql of sources) {
      database.query("BEGIN IMMEDIATE").all();
      try {
        for (const statement of frameHostMigrationSql(sql)) database.query(statement).all();
        database.query("COMMIT").all();
      } catch {
        database.query("ROLLBACK").all();
        throw preflightError("Auth103 source catalog compilation failed");
      }
    }
    const registrations = database.query(AUTH103_NATIVE_REGISTRATION_QUERY).all();
    if (registrations.length !== 1)
      throw preflightError("Auth103 source registration is incomplete");
    const catalog = database
      .query<{ type: string; name: string; tbl_name: string; sql: string | null }, []>(
        AUTH103_NATIVE_CATALOG_QUERY,
      )
      .all();
    const requiredTables = [
      "principals",
      "auth_tokens",
      "auth_principal_incarnations",
      "shared_principal_bindings",
      "credential_authority_classes",
      "shared_auth_sessions",
      "auth103_native_source_registration",
      "tf_v2_container_instances",
      "auth103_native_deployments",
      "auth103_native_deployment_receipts",
      "auth103_native_rp_registrations",
      "auth103_native_rp_registration_receipts",
      "tf_v2_container_acceptances",
      "tf_v2_container_revisions",
      "tf_v2_container_create_claims",
      "tf_v2_container_start_attempts",
      "tf_v2_worker_native_deletions",
    ];
    for (const name of requiredTables) {
      if (catalog.filter((row) => row.type === "table" && row.name === name).length !== 1)
        throw preflightError("Auth103 source catalog is incomplete");
    }
    return Object.freeze({
      digest: dataDigest(catalog),
      projection: Object.freeze(
        catalog.map((row) => Object.freeze([row.type, row.name, row.tbl_name] as const)),
      ),
    });
  } finally {
    database.close();
  }
}

export function compileAuth103NativeSourceCatalog(sources: readonly string[]): string {
  return compileCatalog(sources).digest;
}

/**
 * The original owning build supplies its actual target and exact source commit.
 * No caller refs, ready flags, JSON manifest or custom clock are accepted.
 * Absent canonical103 returns the code literal null, preserving ordinary builds.
 * A present but partial/foreign source registration fails the whole build.
 */
export interface Auth103NativeBuildSource {
  readonly opaqueAuth103NativeBuildSource: unique symbol;
}
/** Source/tool custody captured by the owning implementation, never a caller
 * callback or a manifest field. These inspectors compare DATA; this constructor
 * obtains the expected Git tree and actual owner tool/dependency roots itself. */
function captureRegisteredBuildClosure(sourceRoot: string, commit: string) {
  const originalRun = runCommand;
  const originalBun = Bun;
  const originalSpawn = originalBun.spawn;
  const originalSpawnSync = originalBun.spawnSync;
  const git = realpathSync(Bun.which("git") ?? "");
  const node = realpathSync(Bun.which("node") ?? "");
  const wrangler = realpathSync(WRANGLER);
  const ownerRoot = realpathSync(REPOSITORY);
  const dependencyRoot = realpathSync(join(ownerRoot, "node_modules"));
  if (!wrangler.startsWith(`${dependencyRoot}${sep}`))
    throw preflightError("Auth103 build requires its original owner Wrangler");
  const environment = {
    PATH: `${dirname(node)}:${dirname(git)}:/usr/bin:/bin`,
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_NO_LAZY_FETCH: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_COUNT: "0",
  };
  if (originalBun.spawnSync !== originalSpawnSync)
    throw preflightError("Auth103 source/dependency/tool closure changed during its build");
  const options: Bun.SpawnOptions.SpawnSyncOptions<"ignore", "pipe", "pipe"> & {
    cmd: string[];
  } = {
    cmd: [git, "--no-replace-objects", "-C", sourceRoot, "ls-tree", "-r", "-z", commit],
    env: environment,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    maxBuffer: 32 * 1024 * 1024,
  };
  const result: unknown = (() => {
    try {
      return Reflect.apply(originalSpawnSync, originalBun, [options]);
    } catch {
      throw preflightError("Auth103 exact Git source tree is unavailable");
    }
  })();
  if (
    result === null ||
    typeof result !== "object" ||
    !("exitCode" in result) ||
    typeof result.exitCode !== "number" ||
    !("stdout" in result) ||
    !(result.stdout instanceof Uint8Array) ||
    result.exitCode !== 0 ||
    ("signalCode" in result && result.signalCode !== undefined) ||
    ("exitedDueToMaxBuffer" in result && result.exitedDueToMaxBuffer === true) ||
    ("exitedDueToTimeout" in result && result.exitedDueToTimeout === true)
  )
    throw preflightError("Auth103 exact Git source tree is unavailable");
  const expected = Buffer.from(result.stdout)
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .map((entry) => {
      const match = /^(100644|100755) blob ([0-9a-f]{40})\t([^\0]+)$/u.exec(entry);
      if (match?.[1] === undefined || match[2] === undefined || match[3] === undefined)
        throw preflightError("Auth103 build source tree has unsupported entries");
      return Object.freeze({ path: match[3], blob: match[2], executable: match[1] === "100755" });
    });
  const sourceTree = inspectMoneyNativeBuildSourceTree(sourceRoot, expected);
  const ownerSource = inspectMoneyNativeBuildSourceTree(ownerRoot, expected);
  const dependencies = inspectMoneyNativeBuildDependencyTree(dependencyRoot);
  const selectedDependenciesRoot = join(sourceRoot, "node_modules");
  const selectedDependencies = inspectMoneyNativeBuildDependencyTree(selectedDependenciesRoot);
  if (selectedDependencies.contentDigest !== dependencies.contentDigest)
    throw preflightError("Auth103 selected dependencies differ from the original owner closure");
  for (const root of new Set([sourceRoot, ownerRoot])) {
    for (let parent = dirname(root); ; parent = dirname(parent)) {
      try {
        lstatSync(join(parent, "node_modules"));
        throw preflightError("Auth103 build has an unbound ancestor dependency directory");
      } catch (error) {
        if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
      }
      if (parent === dirname(parent)) break;
    }
  }
  const toolPaths = [
    git,
    node,
    realpathSync(process.execPath),
    wrangler,
    fileURLToPath(import.meta.url),
    join(ownerRoot, "scripts/deploy/process.ts"),
    join(ownerRoot, "scripts/deploy/worker-artifact.ts"),
    join(ownerRoot, "scripts/deploy/realized-config.ts"),
    join(ownerRoot, "scripts/deploy/money-native-build-closure.ts"),
  ];
  const toolSnapshot = () =>
    JSON.stringify(
      toolPaths.map((path) => {
        const before = lstatSync(path, { bigint: true });
        if (!before.isFile() || before.isSymbolicLink())
          throw preflightError("Auth103 owner tool is not a regular file");
        const bytes = readFileSync(path);
        const after = lstatSync(path, { bigint: true });
        const identity = (value: typeof before) =>
          [
            value.dev,
            value.ino,
            value.mode,
            value.size,
            value.nlink,
            value.mtimeNs,
            value.ctimeNs,
          ].join(":");
        if (identity(before) !== identity(after))
          throw preflightError("Auth103 owner tool changed while reading");
        return { path, digest: digest(bytes), identity: identity(after) };
      }),
    );
  const tools = toolSnapshot();
  const assertCurrent = () => {
    if (
      runCommand !== originalRun ||
      Bun !== originalBun ||
      originalBun.spawn !== originalSpawn ||
      originalBun.spawnSync !== originalSpawnSync ||
      realpathSync(WRANGLER) !== wrangler ||
      toolSnapshot() !== tools ||
      inspectMoneyNativeBuildSourceTree(sourceRoot, expected).identityDigest !==
        sourceTree.identityDigest ||
      inspectMoneyNativeBuildSourceTree(ownerRoot, expected).identityDigest !==
        ownerSource.identityDigest ||
      inspectMoneyNativeBuildDependencyTree(dependencyRoot).identityDigest !==
        dependencies.identityDigest ||
      inspectMoneyNativeBuildDependencyTree(selectedDependenciesRoot).identityDigest !==
        selectedDependencies.identityDigest
    )
      throw preflightError("Auth103 source/dependency/tool closure changed during its build");
  };
  let execution:
    | { readonly root: string; readonly environment: Readonly<Record<string, string>> }
    | undefined;
  const run: (command: readonly string[], outputRoot: string) => ReturnType<DeployProcess> = async (
    command,
    outputRoot,
  ) => {
    assertCurrent();
    // Only the original finite dry-run argv is executable through this capture.
    const offset =
      command[1] === "deploy" ? 2 : command[1] === "versions" && command[2] === "upload" ? 3 : -1;
    const args = command.slice(offset);
    if (
      command[0] !== WRANGLER ||
      offset < 0 ||
      args[0] !== "--dry-run" ||
      args[1] !== "--strict" ||
      args[2] !== "--config" ||
      typeof args[3] !== "string" ||
      args[4] !== "--outdir" ||
      typeof args[5] !== "string" ||
      (args.length !== 6 &&
        !(args.length === 8 && args[6] === "--containers-rollout" && args[7] === "none"))
    )
      throw preflightError("Auth103 build refused a foreign executable or non-build command");
    const root = realpathSync(outputRoot);
    const outside = relative(sourceRoot, root);
    const outsideOwner = relative(ownerRoot, root);
    if (
      (!outside.startsWith(`..${sep}`) && !isAbsolute(outside)) ||
      (!outsideOwner.startsWith(`..${sep}`) && !isAbsolute(outsideOwner))
    )
      throw preflightError("Auth103 build outputs must stay outside its source");
    for (const path of [args[3], args[5]]) {
      const local = relative(root, resolve(path));
      if (local === "" || local === ".." || local.startsWith(`..${sep}`) || isAbsolute(local))
        throw preflightError("Auth103 build command leaves its original output root");
    }
    if (execution === undefined) {
      const privateEnvironment: Record<string, string> = { ...environment, CI: "1", NO_COLOR: "1" };
      for (const [key, name] of Object.entries({
        HOME: "auth103-home",
        TMPDIR: "auth103-tmp",
        TMP: "auth103-tmp",
        TEMP: "auth103-tmp",
        XDG_CONFIG_HOME: "auth103-config",
        XDG_CACHE_HOME: "auth103-cache",
      })) {
        const path = join(root, name);
        mkdirSync(path, { mode: 0o700, recursive: true });
        privateEnvironment[key] = path;
      }
      execution = Object.freeze({ root, environment: Object.freeze(privateEnvironment) });
    }
    if (execution.root !== root) throw preflightError("Auth103 build output origin changed");
    const built = await originalRun([node, wrangler, ...command.slice(1)], {
      env: execution.environment,
    });
    assertCurrent();
    return built;
  };
  assertCurrent();
  return Object.freeze({
    assertCurrent,
    run,
    sourceTreeDigest: sourceTree.contentDigest,
    dependencyClosureDigest: dependencies.contentDigest,
    toolClosureDigest: digest(tools),
  });
}

interface BuildOriginal {
  readonly sourceRoot: string;
  readonly commit: string;
  readonly target: DeployTarget;
  readonly accountId: string;
  readonly databaseId: string;
  readonly profile: typeof AUTH103_NATIVE_PROFILE | null;
  readonly sources: readonly { readonly path: string; readonly digest: string }[];
  readonly manifest: Auth103NativeSourceManifest | null;
  readonly closure: ReturnType<typeof captureRegisteredBuildClosure> | null;
  readonly canonicalArtifactDigest: string | null;
}
const builds = new WeakMap<object, BuildOriginal>();

export function prepareAuth103NativeBuildSource(input: {
  readonly sourceRoot: string;
  readonly commit: string;
  readonly target: DeployTarget;
}): Auth103NativeBuildSource {
  if (!/^[0-9a-f]{40}$/u.test(input.commit))
    throw preflightError("Auth103 source build requires an exact commit");
  const profile = input.target.auth103NativeProfile ?? null;
  if (profile !== null && profile !== AUTH103_NATIVE_PROFILE)
    throw preflightError("Auth103 selected profile is unsupported");
  if (
    profile !== null &&
    (input.target.environment !== "integration" ||
      input.target.publicOrigin !== SHARED_AUTH_STAGING_PROFILE.publicOrigin)
  )
    throw preflightError("Auth103 selected profile must retain its actual Root staging origin");
  const origin = {
    sourceRoot: resolve(input.sourceRoot),
    commit: input.commit,
    target: input.target,
    accountId: input.target.accountId,
    databaseId: input.target.d1.databaseId,
    profile,
  };
  const retain = (
    manifest: Auth103NativeSourceManifest | null,
    sources: BuildOriginal["sources"],
    closure: BuildOriginal["closure"] = null,
    canonicalArtifactDigest: string | null = null,
  ) => {
    const capture = Object.freeze({}) as Auth103NativeBuildSource;
    builds.set(
      capture,
      Object.freeze({ ...origin, manifest, sources, closure, canonicalArtifactDigest }),
    );
    return capture;
  };
  // A basic Host never activates Root RP just because canonical103 exists.
  // An explicitly selected profile cannot fall back when registration is absent.
  if (profile === null) return retain(null, Object.freeze([]));
  const physicalCount = readdirSync(resolve(input.sourceRoot, "migrations")).filter((name) =>
    name.endsWith(".sql"),
  ).length;
  if (physicalCount < 100)
    throw preflightError(
      "selected Auth103 profile requires its original canonical source registration",
    );
  assertExactCheckout(input.sourceRoot, input.commit);
  const canonical = readAuth103CanonicalMigrationSource(input.sourceRoot);
  try {
    const names = canonical.artifact.names;
    const closure = captureRegisteredBuildClosure(origin.sourceRoot, input.commit);
    const executingRoot = resolve(import.meta.dir, "../..");
    const identities = requiredSourcePaths.map((path) => {
      const original = exactGitSource(input.sourceRoot, input.commit, path);
      if (source(executingRoot, path) !== original)
        throw preflightError(
          "Auth103 compiler and selected source must be the same implementation",
        );
      return Object.freeze({ path, digest: digest(original) });
    });
    const registered = createAuth103CanonicalSourceArtifacts(input.sourceRoot);
    const sources = names.map((name, index) => {
      if (index < 100 || canonical.physicalNames.length === 103)
        return exactGitSource(input.sourceRoot, input.commit, `migrations/${name}`);
      const successor = canonical.recipes.files[index - 100];
      if (successor === undefined)
        throw preflightError("Auth103 canonical source lacks one owned successor");
      return successor.sql;
    });
    for (let index = 0; index < registered.files.length; index++) {
      const expected = registered.files[index]!;
      if (names[100 + index] !== expected.name || sources[100 + index] !== expected.sql)
        throw preflightError("Auth103 canonical source differs from its owning recipes");
    }
    const catalog = compileCatalog(sources.slice(0, 103));
    const targetRef = dataDigest([
      "takoserver.auth103.native-state-db.v1",
      input.target.accountId,
      input.target.d1.databaseId,
    ]);
    const authSchemaRef = digest(sources[102]!);
    const issuerSourceRef = dataDigest([
      "takoserver.auth103.local-rp-issuer-source.v1",
      identities.filter(({ path }) =>
        [
          "src/shared-auth-oidc-client.ts",
          "src/shared-auth-session.ts",
          "src/worker-request-shared-principal-issuance.ts",
        ].includes(path),
      ),
    ]);
    const configDigest = dataDigest(SHARED_AUTH_STAGING_PROFILE);
    const rpRegistrationRef = dataDigest([
      "takoserver.auth103.local-rp-registration.v1",
      issuerSourceRef,
      configDigest,
      targetRef,
      authSchemaRef,
      registered.clockPolicyRef,
    ]);
    const registrationDigest = dataDigest({
      registrationRef: rpRegistrationRef,
      profile: SHARED_AUTH_STAGING_PROFILE,
      issuerSourceRef,
      configDigest,
      targetRef,
      authSchemaRef,
      clockPolicyRef: registered.clockPolicyRef,
    });
    const manifest: Auth103NativeSourceManifest = Object.freeze({
      version: 1,
      sourceCommit: input.commit,
      sourceRef: dataDigest([
        "takoserver.auth103.native-build-source.v1",
        input.commit,
        identities,
        names.map((name, index) => ({ name, digest: digest(sources[index]!) })),
        closure.sourceTreeDigest,
        closure.dependencyClosureDigest,
        closure.toolClosureDigest,
      ]),
      targetRef,
      authSchemaRef,
      catalogDigest: catalog.digest,
      catalogProjection: catalog.projection,
      registrationRef: registered.registrationRef,
      recipeDigest: registered.recipeDigest,
      clockSourceDigest: registered.clockSourceDigest,
      clockPolicyRef: registered.clockPolicyRef,
      rpRegistration: Object.freeze({
        registrationRef: rpRegistrationRef,
        registrationDigest,
        receiptRef: dataDigest([
          "takoserver.auth103.local-rp-registration-receipt.v1",
          rpRegistrationRef,
          registrationDigest,
        ]),
        issuerSourceRef,
        configDigest,
        profile: SHARED_AUTH_STAGING_PROFILE,
      }),
    });
    return retain(
      manifest,
      Object.freeze([
        ...identities,
        ...canonical.physicalNames.map((name, index) =>
          Object.freeze({ path: `migrations/${name}`, digest: digest(sources[index]!) }),
        ),
      ]),
      closure,
      canonical.artifact.digest,
    );
  } finally {
    canonical.dispose();
  }
}

/** Only the owning config writer consumes the checked build original. */
export function readAuth103NativeBuildDefine(
  capture: unknown,
  target: DeployTarget,
  commit: string,
  sourceRoot: string,
): string {
  const original =
    capture !== null && typeof capture === "object" ? builds.get(capture) : undefined;
  if (
    original === undefined ||
    original.target !== target ||
    original.commit !== commit ||
    original.sourceRoot !== resolve(sourceRoot) ||
    target.accountId !== original.accountId ||
    target.d1.databaseId !== original.databaseId ||
    (target.auth103NativeProfile ?? null) !== original.profile
  )
    throw preflightError("Auth103 build origin does not match the owning config");
  original.closure?.assertCurrent();
  if (original.manifest !== null) assertExactCheckout(original.sourceRoot, original.commit);
  for (const entry of original.sources) {
    if (digest(source(original.sourceRoot, entry.path)) !== entry.digest)
      throw preflightError("Auth103 build source changed during artifact preparation");
  }
  if (original.canonicalArtifactDigest !== null) {
    const canonical = readAuth103CanonicalMigrationSource(original.sourceRoot);
    try {
      if (canonical.artifact.digest !== original.canonicalArtifactDigest)
        throw preflightError("Auth103 canonical source changed during artifact preparation");
      canonical.assertCurrent();
    } finally {
      canonical.dispose();
    }
  }
  return JSON.stringify(original.manifest);
}

/** Execute only the code-owned dry-run against the captured full source/tools.
 * No supplied runner, environment, or installed dependency closure is trusted. */
export async function runAuth103NativeBuildCommand(
  capture: Auth103NativeBuildSource,
  command: readonly string[],
  outputRoot: string,
) {
  const original = builds.get(capture);
  if (original?.closure === null || original?.closure === undefined)
    throw preflightError("Auth103 registered build command requires its original source");
  readAuth103NativeBuildDefine(capture, original.target, original.commit, original.sourceRoot);
  return await original.closure.run(command, outputRoot);
}

export function readAuth103NativeBuildProfileDefine(
  capture: Auth103NativeBuildSource,
  target: DeployTarget,
  commit: string,
  sourceRoot: string,
): string {
  readAuth103NativeBuildDefine(capture, target, commit, sourceRoot);
  const original = builds.get(capture);
  if (original === undefined) throw preflightError("Auth103 profile requires its original build");
  return JSON.stringify(original.profile);
}

export { AUTH103_NATIVE_DEFINE, AUTH103_NATIVE_PROFILE_DEFINE };

/** Fixed environment-scoped companion for the SAME owning schema import.
 * The Worker artifact constructor supplies the original build and real bundle
 * path; there is no supplied record/ref/clock/SQL or apply capability. */
export function createAuth103NativeSourceInstallContribution(
  capture: Auth103NativeBuildSource,
  bundlePath: string,
): string | null {
  const original = builds.get(capture);
  if (original === undefined) throw preflightError("Auth103 install requires its original build");
  if (original.manifest === null) return null;
  readAuth103NativeBuildDefine(capture, original.target, original.commit, original.sourceRoot);
  const stat = lstatSync(bundlePath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
    throw preflightError("Auth103 install requires its owned regular Worker bundle");
  const artifactDigest = digest(readFileSync(bundlePath));
  const manifest = original.manifest;
  const deploymentRef = dataDigest([
    "takoserver.auth103.native-deployment.v1",
    manifest.targetRef,
    manifest.sourceRef,
    artifactDigest,
  ]);
  const deploymentReceiptRef = dataDigest([
    "takoserver.auth103.native-deployment-receipt.v1",
    deploymentRef,
  ]);
  const rp = auth103RpRegistrationRecord(manifest);
  const rpJson = canonicalJson(rp);
  const deploymentJson = canonicalJson({
    receiptRef: deploymentReceiptRef,
    manifest,
    artifactDigest,
    rpRecordJson: rpJson,
  });
  // Existing RP configuration originals may be reused only byte-exact. The
  // mandatory LAST deployment receipt proves both RP rows, so a zero-row
  // conditional insert or a conflicting partial original cannot commit.
  return `INSERT INTO auth103_native_rp_registrations(registration_ref,registration_digest,record_json)
SELECT ${[rp.registrationRef, rp.registrationDigest, rpJson].map(literal).join(",")}
WHERE NOT EXISTS(SELECT 1 FROM auth103_native_rp_registrations WHERE registration_ref=${literal(rp.registrationRef)}) RETURNING *;
INSERT INTO auth103_native_rp_registration_receipts(receipt_ref,registration_ref,record_json)
SELECT ${[rp.receiptRef, rp.registrationRef, rpJson].map(literal).join(",")}
WHERE NOT EXISTS(SELECT 1 FROM auth103_native_rp_registration_receipts WHERE receipt_ref=${literal(rp.receiptRef)}) RETURNING *;
INSERT INTO auth103_native_deployments(deployment_ref,target_ref,source_ref,artifact_digest,record_json) VALUES
(${[deploymentRef, manifest.targetRef, manifest.sourceRef, artifactDigest, deploymentJson].map(literal).join(",")}) RETURNING *;
INSERT INTO auth103_native_deployment_receipts(receipt_ref,deployment_ref,record_json) VALUES
(${[deploymentReceiptRef, deploymentRef, deploymentJson].map(literal).join(",")}) RETURNING *;\n`;
}
