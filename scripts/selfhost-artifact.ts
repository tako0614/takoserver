import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import {
  accessSync,
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { createFileObjectStore } from "../src/objects-fs.ts";
import { type ObjectStore, ObjectStoreError } from "../src/ports.ts";
import {
  privateDirectoryChainProblem,
  resolveSelfhostDataRoot,
  SELFHOST_DATA_ROOT_VARIABLE,
  SELFHOST_MEMORY_DATA_ROOT,
} from "../src/selfhost-data-root.ts";
import {
  parseTakoformV2PublicConfig,
  V2ApplicationConfigError,
} from "../src/takoform-v2/config.ts";
import {
  createV2HeldArtifactSource,
  V2ArtifactSourceError,
  type V2HeldArtifactEntry,
  type V2HeldArtifactGrant,
} from "../src/takoform-v2/forms/artifact-source.ts";
import {
  isArtifactUrl,
  isValidArtifactPath,
} from "../src/takoform-v2/forms/artifact-validation.ts";
import {
  SQLITE_MIGRATION_SET_FORM_URL,
  SQLITE_MIGRATION_SET_LIMITS,
  SQLiteMigrationSetValidationError,
  validateSQLiteMigrationPayload,
} from "../src/takoform-v2/forms/sqlite-migration-set.ts";
import {
  STATIC_ASSET_BUNDLE_FORM_URL,
  STATIC_ASSET_BUNDLE_LIMITS,
  StaticAssetBundleValidationError,
  validateStaticAssetBundlePayload,
} from "../src/takoform-v2/forms/static-asset-bundle.ts";
import {
  validateWorkerBundlePayload,
  WORKER_BUNDLE_FORM_URL,
  WORKER_BUNDLE_LIMITS,
  WorkerBundleValidationError,
} from "../src/takoform-v2/forms/worker-bundle.ts";

/**
 * Held artifacts for a stopped self-host.
 *
 * The v2 artifact Forms (`WorkerBundle`, `StaticAssetBundle`,
 * `SQLiteMigrationSet`) never upload or fetch bytes: a create names an exact
 * HTTPS URL and SHA-256, and the Host serves it only from bytes it already
 * holds in its object store, for the organizations the operator granted in
 * `TAKOSERVER_TAKOFORM_V2_CONFIG`. This is the operator tool that puts them
 * there.
 *
 *   bun scripts/selfhost-artifact.ts seed <worker-bundle|static-asset-bundle|sqlite-migration-set> <dir>
 *     --base-url https://artifacts.example.com/<name>/<version>/
 *     --organization <organizationId> [--organization ...]
 *     [--entrypoint worker.js] [--media-type <path>=<type> ...] [--include-dotfiles]
 *     [--target-key KEY] [--config FILE [--add-grants]] [--data-root DIR]
 *
 *   bun scripts/selfhost-artifact.ts verify [--config FILE] [--data-root DIR]
 *
 * `seed` reads every regular file below `<dir>`, builds the Form's manifest
 * (files in byte order of their relative paths), checks it with the Form's own
 * validator, writes the manifest and each file under the content address
 * `operator-held/sha256/<hex>` through the Host's file object store, reads them
 * back through the Host's held-artifact source, and prints one JSON result:
 * the `artifact` to put in the Resource spec and the exact
 * `TAKOSERVER_TAKOFORM_V2_CONFIG` fragment that grants it. With `--config` it
 * also merges that fragment into the given config file. The URLs are
 * identities only; nothing is fetched from them.
 *
 * It refuses, before writing anything, a data root that is missing, not owned
 * by this user and private (the rule the v2 private planes use), or without a
 * control database. It then holds a write lock (`BEGIN IMMEDIATE`) on the
 * control database until it has finished, so a Host started meanwhile stops at
 * its first database write, and refuses while any other process has a file
 * under the data root open: a running Host keeps its control database open,
 * and every process descriptor table in `/proc` is checked; a process of this
 * user whose table cannot be read makes that proof impossible and is refused
 * too. It also refuses an organization the control database does not know,
 * dotfiles unless `--include-dotfiles`, a config that would no longer fit in
 * one environment variable, a grant to an already configured entry unless
 * `--add-grants`, and any input the Form would reject. The Host reads held
 * artifacts only at startup, so a seed is always followed by a restart with
 * the updated configuration.
 *
 * `verify` is read-only and safe while the Host runs: it reads every entry of
 * every configured block through the same source and reports each one that is
 * missing or whose bytes do not match its digest.
 */

/** The target both Worker bundle blocks need for the complete local Worker profile (entry-bun.ts). */
export const SELFHOST_V2_WORKER_TARGET_KEY = "selfhost-v2-worker-primary";
export const SELFHOST_V2_SQLITE_MIGRATION_TARGET_KEY = "selfhost-v2-sqlite-migration-primary";
export const HELD_OBJECT_PREFIX = "operator-held/sha256/";
const RESULT_KIND = "takoserver.selfhost-held-artifact-seed@v1";
const VERIFY_KIND = "takoserver.selfhost-held-artifact-verify@v1";
const MAX_HELD_READ_BYTES = 134_217_728;
const MAX_LISTED_HOLDERS = 5;
/** How long the seed waits for a writer that holds the control database. */
const CONTROL_LOCK_WAIT_MS = 1_000;
/** MAX_ARG_STRLEN: one `NAME=value` string, with its terminator, that execve accepts. */
const LINUX_ENVIRONMENT_STRING_MAX_BYTES = 131_072;

type ConfigBlock = "workerBundle" | "staticAssetBundle" | "sqliteMigrationSet";
const CONFIG_BLOCKS: readonly ConfigBlock[] = [
  "sqliteMigrationSet",
  "workerBundle",
  "staticAssetBundle",
];

interface Limits {
  readonly manifestBytes: number;
  readonly fileCount: number;
  readonly fileBytes: number;
  readonly aggregateBytes: number;
}

interface ObservedFile {
  readonly path: string;
  readonly sha256: string;
  readonly mediaType: string;
  readonly byteSize: number;
}

interface FormProfile {
  readonly title: string;
  readonly url: string;
  readonly block: ConfigBlock;
  readonly defaultTargetKey: string;
  readonly limits: Limits;
  readonly hasEntrypoint: boolean;
  readonly entrypointMediaType?: string;
  mediaType(path: string): string | undefined;
  validate(input: {
    readonly spec: unknown;
    readonly manifestBytes: Uint8Array;
    readonly fileBytes: readonly Uint8Array[];
  }): Promise<{ readonly observed: { readonly files: readonly ObservedFile[] } }>;
  readonly validationError: new (...args: never[]) => Error & { readonly code: string };
}

const WORKER_MEDIA_TYPES: Readonly<Record<string, string>> = {
  ".js": "application/javascript+module",
  ".mjs": "application/javascript+module",
  ".wasm": "application/wasm",
  ".txt": "text/plain",
  ".bin": "application/octet-stream",
};

/** Parameter-free types only: the StaticAssetBundle media type grammar has no parameters. */
const STATIC_MEDIA_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html",
  ".htm": "text/html",
  ".css": "text/css",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".json": "application/json",
  ".map": "application/json",
  ".webmanifest": "application/manifest+json",
  ".xml": "application/xml",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".csv": "text/csv",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".wasm": "application/wasm",
  ".pdf": "application/pdf",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
};

const extension = (path: string): string => extname(basename(path)).toLowerCase();

const PROFILES: Readonly<Record<string, FormProfile>> = {
  "worker-bundle": {
    title: "WorkerBundle",
    url: WORKER_BUNDLE_FORM_URL,
    block: "workerBundle",
    defaultTargetKey: SELFHOST_V2_WORKER_TARGET_KEY,
    limits: WORKER_BUNDLE_LIMITS,
    hasEntrypoint: true,
    entrypointMediaType: "application/javascript+module",
    mediaType: (path) => WORKER_MEDIA_TYPES[extension(path)],
    validate: validateWorkerBundlePayload,
    validationError: WorkerBundleValidationError,
  },
  "static-asset-bundle": {
    title: "StaticAssetBundle",
    url: STATIC_ASSET_BUNDLE_FORM_URL,
    block: "staticAssetBundle",
    defaultTargetKey: SELFHOST_V2_WORKER_TARGET_KEY,
    limits: STATIC_ASSET_BUNDLE_LIMITS,
    hasEntrypoint: false,
    mediaType: (path) => STATIC_MEDIA_TYPES[extension(path)] ?? "application/octet-stream",
    validate: validateStaticAssetBundlePayload,
    validationError: StaticAssetBundleValidationError,
  },
  "sqlite-migration-set": {
    title: "SQLiteMigrationSet",
    url: SQLITE_MIGRATION_SET_FORM_URL,
    block: "sqliteMigrationSet",
    defaultTargetKey: SELFHOST_V2_SQLITE_MIGRATION_TARGET_KEY,
    limits: SQLITE_MIGRATION_SET_LIMITS,
    hasEntrypoint: false,
    mediaType: (path) => (extension(path) === ".sql" ? "application/sql" : undefined),
    validate: validateSQLiteMigrationPayload,
    validationError: SQLiteMigrationSetValidationError,
  },
};

export interface SelfhostArtifactCliIo {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly cwd: string;
  /** Where the process table is read; `/proc` outside tests. */
  readonly procRoot: string;
}

/** A refusal the operator can act on; printed as it is and exit code 1. */
class Refusal extends Error {}

const USAGE =
  "usage: selfhost-artifact.ts seed <worker-bundle|static-asset-bundle|sqlite-migration-set> <dir>\n" +
  "         --base-url https://... --organization <organizationId> [--organization ...]\n" +
  "         [--entrypoint <path>] [--media-type <path>=<type> ...] [--include-dotfiles]\n" +
  "         [--target-key <key>] [--config <file> [--add-grants]] [--data-root <dir>]\n" +
  "       selfhost-artifact.ts verify [--config <file>] [--data-root <dir>]\n";

const SEED_FLAGS = [
  "base-url",
  "organization",
  "entrypoint",
  "media-type",
  "target-key",
  "config",
  "data-root",
  "include-dotfiles",
  "add-grants",
] as const;
const VERIFY_FLAGS = ["config", "data-root"] as const;
const REPEATABLE_FLAGS = new Set(["organization", "media-type"]);
/** Flags that take no value. */
const SWITCH_FLAGS = new Set(["include-dotfiles", "add-grants"]);

export async function runSelfhostArtifactCli(
  argv: readonly string[],
  overrides: Partial<SelfhostArtifactCliIo> = {},
): Promise<number> {
  const io: SelfhostArtifactCliIo = {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    env: process.env,
    cwd: process.cwd(),
    procRoot: "/proc",
    ...overrides,
  };
  const [command, ...rest] = argv;
  const parsed =
    command === "seed"
      ? parseArguments(rest, SEED_FLAGS)
      : command === "verify"
        ? parseArguments(rest, VERIFY_FLAGS)
        : null;
  if (!parsed) {
    io.stderr(USAGE);
    return 2;
  }
  try {
    if (command === "seed") {
      const [formName, sourceDirectory, ...extra] = parsed.positional;
      const profile = formName ? PROFILES[formName] : undefined;
      const missing = !parsed.flags.has("base-url")
        ? "--base-url"
        : !parsed.flags.has("organization")
          ? "--organization"
          : undefined;
      if (!profile || !sourceDirectory || extra.length > 0 || missing) {
        io.stderr(`${missing ? `seed needs ${missing}\n` : ""}${USAGE}`);
        return 2;
      }
      return await seed(profile, sourceDirectory, parsed.flags, io);
    }
    if (parsed.positional.length > 0) {
      io.stderr(USAGE);
      return 2;
    }
    return await verify(parsed.flags, io);
  } catch (error) {
    if (error instanceof Refusal) {
      io.stderr(`selfhost-artifact: ${error.message}\n`);
    } else if (error instanceof ObjectStoreError) {
      io.stderr(`selfhost-artifact: the object store refused the write: ${error.message}\n`);
    } else {
      io.stderr(
        `selfhost-artifact: ${error instanceof Error ? `${error.name}: ${error.message}` : "failed"}\n`,
      );
    }
    return 1;
  }
}

function parseArguments(
  args: readonly string[],
  allowed: readonly string[],
): { positional: string[]; flags: Map<string, string[]> } | null {
  const positional: string[] = [];
  const flags = new Map<string, string[]>();
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index] as string;
    if (!argument.startsWith("--")) {
      positional.push(argument);
      continue;
    }
    const name = argument.slice(2);
    if (!allowed.includes(name)) return null;
    const values = flags.get(name) ?? [];
    if (values.length > 0 && !REPEATABLE_FLAGS.has(name)) return null;
    if (SWITCH_FLAGS.has(name)) {
      flags.set(name, ["1"]);
      continue;
    }
    const value = args[index + 1];
    if (value === undefined) return null;
    values.push(value);
    flags.set(name, values);
    index += 1;
  }
  return { positional, flags };
}

const single = (flags: Map<string, string[]>, name: string): string | undefined =>
  flags.get(name)?.[0];

async function seed(
  profile: FormProfile,
  sourceDirectory: string,
  flags: Map<string, string[]>,
  io: SelfhostArtifactCliIo,
): Promise<number> {
  const baseUrl = artifactBaseUrl(single(flags, "base-url") ?? "");
  const organizations = [...new Set(flags.get("organization") ?? [])];
  for (const organization of organizations) {
    if (organization.trim() === "" || organization !== organization.trim()) {
      throw new Refusal(`--organization ${JSON.stringify(organization)} is not an organization id`);
    }
  }
  const explicitTargetKey = single(flags, "target-key");
  if (explicitTargetKey !== undefined && explicitTargetKey.trim() === "") {
    throw new Refusal("--target-key must not be empty");
  }
  if (single(flags, "entrypoint") !== undefined && !profile.hasEntrypoint) {
    throw new Refusal(`--entrypoint applies only to worker-bundle, not to ${profile.title}`);
  }
  const configPath = single(flags, "config");
  if (flags.has("add-grants") && !configPath) {
    throw new Refusal("--add-grants applies only with --config");
  }
  const installation = lockStoppedInstallation(single(flags, "data-root"), io);
  try {
    return await seedLocked(profile, sourceDirectory, flags, io, {
      baseUrl,
      organizations,
      explicitTargetKey,
      configPath,
      installation,
    });
  } finally {
    installation.release();
  }
}

async function seedLocked(
  profile: FormProfile,
  sourceDirectory: string,
  flags: Map<string, string[]>,
  io: SelfhostArtifactCliIo,
  input: {
    readonly baseUrl: string;
    readonly organizations: readonly string[];
    readonly explicitTargetKey: string | undefined;
    readonly configPath: string | undefined;
    readonly installation: LockedInstallation;
  },
): Promise<number> {
  const { baseUrl, organizations, explicitTargetKey, configPath, installation } = input;
  const names = organizationNames(installation, organizations);
  const unknown = organizations.filter((organization) => !names.has(organization));
  if (unknown.length > 0) {
    throw new Refusal(
      `${installation.databasePath} has no organization ${unknown.map((id) => JSON.stringify(id)).join(", ")}; ` +
        "create it first (POST /v1/organizations) or check the id in GET /v1/me",
    );
  }

  // Everything the Host would refuse is refused here, before any byte is written.
  const files = readSourceTree(resolve(io.cwd, sourceDirectory), profile.limits, {
    includeDotfiles: flags.has("include-dotfiles"),
  });
  const overrides = mediaTypeOverrides(flags.get("media-type") ?? [], files);
  const manifestFiles = files.map((file) => {
    const mediaType = overrides.get(file.path) ?? profile.mediaType(file.path);
    if (!mediaType) {
      throw new Refusal(
        `cannot infer the ${profile.title} media type of ${file.path}; ` +
          `pass --media-type ${file.path}=<type>`,
      );
    }
    return {
      path: file.path,
      url: `${baseUrl}files/${file.path.split("/").map(encodeURIComponent).join("/")}`,
      sha256: hexDigest(file.bytes),
      mediaType,
    };
  });
  for (const file of manifestFiles) {
    if (!isArtifactUrl(file.url)) {
      throw new Refusal(`the artifact URL for ${file.path} is not a valid HTTPS artifact URL`);
    }
  }
  const manifest = profile.hasEntrypoint
    ? {
        entrypoint: entrypointFor(profile, single(flags, "entrypoint"), manifestFiles),
        files: manifestFiles,
      }
    : { files: manifestFiles };
  const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest));
  const artifact = { url: `${baseUrl}manifest.json`, sha256: hexDigest(manifestBytes) };
  const fileBytes = files.map((file) => file.bytes);
  const observation = await formValidation(profile, {
    spec: { artifact },
    manifestBytes,
    fileBytes,
  });

  const grants: V2HeldArtifactGrant[] = organizations.map((organization) => ({
    principal: `org:${organization}`,
    space: organization,
  }));
  const entries: V2HeldArtifactEntry[] = [
    {
      url: artifact.url,
      sha256: artifact.sha256,
      objectKey: heldObjectKey(artifact.sha256),
      grants,
    },
    ...manifestFiles.map((file) => ({
      url: file.url,
      sha256: file.sha256,
      objectKey: heldObjectKey(file.sha256),
      grants,
    })),
  ];
  const config = configPath
    ? prepareConfigMerge(resolve(io.cwd, configPath), profile, explicitTargetKey, entries, {
        addGrants: flags.has("add-grants"),
      })
    : undefined;
  const targetKey = config?.targetKey ?? explicitTargetKey ?? profile.defaultTargetKey;
  const configFragment = { [profile.block]: { targetKey, heldArtifacts: entries } };
  // The fragment on its own is exactly what the Host's strict startup parser accepts.
  const fragmentText = JSON.stringify({
    documentation: "https://example.invalid/",
    authenticationDocumentation: "https://example.invalid/",
    ...configFragment,
  });
  parseConfigText(fragmentText, "the generated configuration fragment");
  const notes = [...(config?.notes ?? [])];
  const fragmentBytes = environmentBytes(fragmentText);
  if (!config && fragmentBytes > LINUX_ENVIRONMENT_STRING_MAX_BYTES) {
    notes.push(
      `warning: this fragment alone is ${fragmentBytes} bytes as TAKOSERVER_TAKOFORM_V2_CONFIG; Linux passes at most ${LINUX_ENVIRONMENT_STRING_MAX_BYTES} bytes in one environment variable, so no config holding it can start the Host`,
    );
  }

  const objects = createFileObjectStore({ root: installation.dataRoot });
  const bytesByDigest = new Map<string, Uint8Array>([[artifact.sha256, manifestBytes]]);
  for (const [index, file] of manifestFiles.entries()) {
    bytesByDigest.set(file.sha256, fileBytes[index] as Uint8Array);
  }
  let created = 0;
  for (const [digest, bytes] of bytesByDigest) {
    if (await storeHeldObject(objects, digest, bytes)) created += 1;
  }

  // Post-condition: the Host's own held source serves every entry, digest-checked,
  // under the Form's own size bounds, exactly as a create will read it.
  const source = createV2HeldArtifactSource({ objects, entries });
  const reader = grants[0] as V2HeldArtifactGrant;
  for (const [index, entry] of entries.entries()) {
    try {
      await source.read({
        ...reader,
        url: entry.url,
        sha256: entry.sha256,
        maxBytes: index === 0 ? profile.limits.manifestBytes : profile.limits.fileBytes,
      });
    } catch (error) {
      const code = error instanceof V2ArtifactSourceError ? error.code : "unavailable";
      throw new Refusal(`read-back of ${entry.url} failed (${code}) after it was written`);
    }
  }

  let configProblem: string | undefined;
  if (config) {
    try {
      config.write();
    } catch (error) {
      configProblem = error instanceof Error ? error.message : "the config file was not updated";
    }
  }

  io.stdout(
    `${JSON.stringify(
      {
        kind: RESULT_KIND,
        form: profile.url,
        configBlock: profile.block,
        targetKey,
        artifact,
        files: observation.observed.files.map((file) => ({
          path: file.path,
          sha256: file.sha256,
          mediaType: file.mediaType,
          byteSize: file.byteSize,
        })),
        configFragment,
      },
      null,
      2,
    )}\n`,
  );
  const lines = [
    `seeded ${profile.title} into ${installation.dataRoot}: ${bytesByDigest.size} object(s), ${created} new, under objects/${HELD_OBJECT_PREFIX}`,
    `files (${observation.observed.files.length}):`,
    ...observation.observed.files.map(
      (file) => `  ${file.path} (${file.mediaType}, ${file.byteSize} bytes)`,
    ),
    `granted to ${organizations.map((id) => `org:${id} (${names.get(id)})`).join(", ")}`,
    `create it with form ${profile.url} and spec ${JSON.stringify({ artifact })}`,
    config
      ? `updated ${config.path}: ${profile.block} now holds ${config.entryCount} held artifact(s)`
      : `add configFragment.${profile.block}.heldArtifacts to TAKOSERVER_TAKOFORM_V2_CONFIG (target ${targetKey}), or pass --config <file>`,
    ...notes,
    "then restart the Host with that configuration: it reads held artifacts only at startup",
  ];
  io.stderr(`${lines.join("\n")}\n`);
  if (configProblem) {
    io.stderr(`selfhost-artifact: ${configProblem}\n`);
    return 1;
  }
  return 0;
}

async function verify(flags: Map<string, string[]>, io: SelfhostArtifactCliIo): Promise<number> {
  const configPath = single(flags, "config");
  const text = configPath
    ? readConfigFile(resolve(io.cwd, configPath))
    : io.env.TAKOSERVER_TAKOFORM_V2_CONFIG;
  if (!text) {
    throw new Refusal("verify needs --config <file> or TAKOSERVER_TAKOFORM_V2_CONFIG");
  }
  const config = parseConfigText(text, configPath ?? "TAKOSERVER_TAKOFORM_V2_CONFIG");
  const dataRoot = existingDataRoot(single(flags, "data-root"), io);
  const objects = createFileObjectStore({ root: dataRoot });
  let checked = 0;
  const failures: {
    block: ConfigBlock;
    url: string;
    sha256: string;
    principal: string;
    code: string;
  }[] = [];
  for (const block of CONFIG_BLOCKS) {
    const entries = config[block]?.heldArtifacts ?? [];
    const source = createV2HeldArtifactSource({ objects, entries });
    for (const entry of entries) {
      checked += 1;
      const grant = entry.grants[0] as V2HeldArtifactGrant;
      try {
        await source.read({
          principal: grant.principal,
          space: grant.space,
          url: entry.url,
          sha256: entry.sha256,
          maxBytes: MAX_HELD_READ_BYTES,
        });
      } catch (error) {
        failures.push({
          block,
          url: entry.url,
          sha256: entry.sha256,
          principal: grant.principal,
          code: error instanceof V2ArtifactSourceError ? error.code : "unavailable",
        });
      }
    }
  }
  io.stdout(`${JSON.stringify({ kind: VERIFY_KIND, dataRoot, checked, failures }, null, 2)}\n`);
  io.stderr(
    failures.length === 0
      ? `all ${checked} held artifact(s) are present with their exact bytes\n`
      : `${failures.length} of ${checked} held artifact(s) cannot be served; seed them again\n`,
  );
  return failures.length === 0 ? 0 : 1;
}

function artifactBaseUrl(value: string): string {
  const base = value.endsWith("/") ? value : `${value}/`;
  if (!isArtifactUrl(`${base}manifest.json`)) {
    throw new Refusal(
      "--base-url must be an absolute https:// URL of printable ASCII without credentials, query or fragment",
    );
  }
  return base;
}

interface LockedInstallation {
  readonly dataRoot: string;
  readonly databasePath: string;
  /** The control database, inside the `BEGIN IMMEDIATE` held for the whole seed. */
  readonly database: Database;
  release(): void;
}

function existingDataRoot(flag: string | undefined, io: SelfhostArtifactCliIo): string {
  if (io.env.TAKOSERVER_OBJECTS_IN_MEMORY === "1") {
    throw new Refusal(
      "TAKOSERVER_OBJECTS_IN_MEMORY=1 keeps objects in memory; there is no object store on disk",
    );
  }
  const configured = flag ?? io.env[SELFHOST_DATA_ROOT_VARIABLE];
  if (configured === SELFHOST_MEMORY_DATA_ROOT) {
    throw new Refusal(`a ${SELFHOST_MEMORY_DATA_ROOT} data root has no object store on disk`);
  }
  let dataRoot: string;
  try {
    // The same resolution as the Host entry, so both name one canonical root.
    dataRoot = resolveSelfhostDataRoot(configured, io.cwd);
  } catch (error) {
    throw new Refusal(error instanceof Error ? error.message : "the data root cannot be resolved");
  }
  if (!existsSync(dataRoot)) {
    throw new Refusal(
      `${dataRoot} does not exist; start the Host once (first boot) to create it and an organization, then stop it`,
    );
  }
  return dataRoot;
}

/**
 * The data root of an installation that has booted once and is not running
 * now, with the control database's write lock held until `release()`.
 *
 * The lock comes first: a Host that starts after it cannot write its control
 * database (its first write waits out its busy timeout and fails), so the
 * process scan below cannot be outrun, even by a Host this process cannot see.
 */
function lockStoppedInstallation(
  flag: string | undefined,
  io: SelfhostArtifactCliIo,
): LockedInstallation {
  const dataRoot = existingDataRoot(flag, io);
  const problem = privateDirectoryChainProblem(dataRoot, SELFHOST_DATA_ROOT_VARIABLE);
  if (problem) {
    throw new Refusal(`${problem}; run this command as the Host's user`);
  }
  const configuredDatabase = io.env.TAKOSERVER_DB;
  if (configuredDatabase === ":memory:") {
    throw new Refusal("TAKOSERVER_DB=:memory: keeps no organizations to grant to");
  }
  const databasePath = configuredDatabase
    ? resolve(io.cwd, configuredDatabase)
    : join(dataRoot, "control.sqlite");
  if (!statSync(databasePath, { throwIfNoEntry: false })?.isFile()) {
    throw new Refusal(
      `control database ${databasePath} does not exist; start the Host once (first boot), create the organization, then stop it`,
    );
  }
  let database: Database | undefined;
  try {
    database = new Database(databasePath, { readwrite: true, create: false });
    database.run(`PRAGMA busy_timeout = ${CONTROL_LOCK_WAIT_MS}`);
    database.run("BEGIN IMMEDIATE");
  } catch (error) {
    database?.close();
    throw new Refusal(
      `cannot take the write lock on ${databasePath} (${error instanceof Error ? error.message : "unknown error"}); ` +
        "a Host or another writer is using it. Stop the Host and every other process using this data root, then seed again",
    );
  }
  const locked = database;
  const release = (): void => {
    try {
      locked.run("ROLLBACK");
    } catch {
      // Nothing was written; closing releases the lock in any case.
    }
    locked.close();
  };
  try {
    const scan = dataRootHolders({
      procRoot: io.procRoot,
      dataRoot,
      // Descriptors name the real file, so compare against its canonical path.
      files: [realpathSync(databasePath)],
      selfPid: process.pid,
      selfUid: process.getuid?.(),
    });
    if (scan === "unprovable") {
      throw new Refusal(
        `cannot prove that no Host is running: ${io.procRoot} does not show this process's open files (seeding needs Linux /proc, in the Host's PID namespace)`,
      );
    }
    if (scan.unreadable.length > 0) {
      throw new Refusal(
        `cannot prove that no Host is running: this user's process(es) ${scan.unreadable
          .slice(0, MAX_LISTED_HOLDERS)
          .map((pid) => `pid ${pid}`)
          .join(
            ", ",
          )} do not show their open files (for example a bun given file capabilities with setcap). ` +
          "Stop them, or run this command as root in the Host's PID namespace",
      );
    }
    if (scan.holders.length > 0) {
      const listed = scan.holders
        .slice(0, MAX_LISTED_HOLDERS)
        .map((holder) => `pid ${holder.pid} has ${holder.path} open`)
        .join("; ");
      throw new Refusal(
        `${dataRoot} is in use (${listed}${scan.holders.length > MAX_LISTED_HOLDERS ? "; ..." : ""}). ` +
          "Stop the Host and every other process using this data root, then seed again",
      );
    }
  } catch (error) {
    release();
    throw error;
  }
  return { dataRoot, databasePath, database: locked, release };
}

export interface DataRootHolder {
  readonly pid: number;
  readonly path: string;
}

/**
 * Every other process with a file at or below `dataRoot`, or one of `files`,
 * open. A running Host keeps its control database open for its whole life.
 * `unreadable` lists this user's processes whose descriptor table cannot be
 * read (a non-dumpable process, such as one with file capabilities): any of
 * them could be the Host. `unprovable` when the process table does not show
 * this process's own descriptors, so an empty answer would mean nothing.
 * Another user's unreadable process is skipped: it cannot open anything in a
 * root private to this user.
 */
export function dataRootHolders(input: {
  readonly procRoot: string;
  readonly dataRoot: string;
  readonly files: readonly string[];
  readonly selfPid: number;
  readonly selfUid: number | undefined;
}): { holders: DataRootHolder[]; unreadable: number[] } | "unprovable" {
  let processes: string[];
  try {
    processes = readdirSync(input.procRoot);
    readdirSync(join(input.procRoot, String(input.selfPid), "fd"));
  } catch {
    return "unprovable";
  }
  const prefix = input.dataRoot.endsWith("/") ? input.dataRoot : `${input.dataRoot}/`;
  const holders: DataRootHolder[] = [];
  const unreadable: number[] = [];
  for (const entry of processes) {
    if (!/^[0-9]+$/u.test(entry) || Number(entry) === input.selfPid) continue;
    let descriptors: string[];
    try {
      descriptors = readdirSync(join(input.procRoot, entry, "fd"));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      // Exited while scanning.
      if (code === "ENOENT" || code === "ESRCH") continue;
      let owner: number | undefined;
      try {
        owner = statSync(join(input.procRoot, entry)).uid;
      } catch {
        continue;
      }
      // A zombie has already closed every file, and its table is never readable.
      if (owner === input.selfUid && !exitedProcess(input.procRoot, entry)) {
        unreadable.push(Number(entry));
      }
      continue;
    }
    for (const descriptor of descriptors) {
      let target: string;
      try {
        target = readlinkSync(join(input.procRoot, entry, "fd", descriptor));
      } catch {
        continue;
      }
      const path = target.endsWith(" (deleted)") ? target.slice(0, -" (deleted)".length) : target;
      if (path === input.dataRoot || path.startsWith(prefix) || input.files.includes(path)) {
        holders.push({ pid: Number(entry), path });
        break;
      }
    }
  }
  return { holders, unreadable };
}

/** Whether `/proc/<pid>/stat` reports a zombie or dead process. */
function exitedProcess(procRoot: string, pid: string): boolean {
  try {
    const stat = readFileSync(join(procRoot, pid, "stat"), "utf8");
    const state = stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3);
    return state === "Z" || state === "X";
  } catch {
    return false;
  }
}

/** Each known organization's display name, read inside the held lock. */
function organizationNames(
  installation: LockedInstallation,
  organizations: readonly string[],
): Map<string, string> {
  const names = new Map<string, string>();
  try {
    const query = installation.database.query("SELECT name FROM orgs WHERE id = ?");
    for (const organization of organizations) {
      const row = query.get(organization) as { name?: unknown } | null;
      if (row) names.set(organization, typeof row.name === "string" ? row.name : "");
    }
  } catch (error) {
    throw new Refusal(
      `cannot read organizations from ${installation.databasePath} (${error instanceof Error ? error.message : "unknown error"}); ` +
        "start and stop the Host once so it brings the control database up to date",
    );
  }
  return names;
}

interface SourceFile {
  readonly path: string;
  readonly bytes: Uint8Array;
}

/**
 * Every regular file below `directory`, in byte order of its relative path.
 * Each file is opened without following a symbolic link and must still be the
 * inode `lstat` saw, so a swap between the two cannot smuggle another file in.
 * A path with a component that starts with `.` (`.env`, `.git/config`) is
 * refused unless explicitly included: a StaticAssetBundle publishes every file.
 */
function readSourceTree(
  directory: string,
  limits: Limits,
  options: { readonly includeDotfiles: boolean },
): SourceFile[] {
  if (!lstatSync(directory, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Refusal(`source ${directory} must be a directory, not a symbolic link or a file`);
  }
  const files: SourceFile[] = [];
  let totalBytes = 0;
  const walk = (absolute: string, relative: string): void => {
    const before = lstatSync(absolute);
    const names = readdirSync(absolute);
    const after = lstatSync(absolute);
    if (!after.isDirectory() || after.dev !== before.dev || after.ino !== before.ino) {
      throw new Refusal(`source ${relative || directory} changed while it was read`);
    }
    for (const name of names) {
      const path = relative ? `${relative}/${name}` : name;
      if (name.startsWith(".") && !options.includeDotfiles) {
        throw new Refusal(
          `source ${path} starts with "."; dotfiles such as .env or .git are not seeded unless --include-dotfiles`,
        );
      }
      const child = join(absolute, name);
      const metadata = lstatSync(child);
      if (metadata.isSymbolicLink()) {
        throw new Refusal(`source ${path} is a symbolic link; put the file itself in the source`);
      }
      if (metadata.isDirectory()) {
        walk(child, path);
        continue;
      }
      if (!metadata.isFile()) throw new Refusal(`source ${path} is not a regular file`);
      if (!isValidArtifactPath(path)) {
        throw new Refusal(`source ${JSON.stringify(path)} is not a valid artifact path`);
      }
      if (files.length >= limits.fileCount) {
        throw new Refusal(`source holds more than ${limits.fileCount} files`);
      }
      files.push({ path, bytes: readSourceFile(child, path, metadata, limits) });
      totalBytes += (files.at(-1) as SourceFile).bytes.byteLength;
      if (totalBytes > limits.aggregateBytes) {
        throw new Refusal(`source files are larger than ${limits.aggregateBytes} bytes together`);
      }
    }
  };
  walk(directory, "");
  if (files.length === 0) throw new Refusal(`source ${directory} has no files`);
  const encoder = new TextEncoder();
  return files.sort((left, right) =>
    Buffer.compare(encoder.encode(left.path), encoder.encode(right.path)),
  );
}

function readSourceFile(
  absolute: string,
  path: string,
  seen: { readonly dev: number; readonly ino: number },
  limits: Limits,
): Uint8Array {
  let descriptor: number;
  try {
    descriptor = openSync(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    throw new Refusal(
      code === "ELOOP"
        ? `source ${path} is a symbolic link; put the file itself in the source`
        : `source ${path} cannot be opened (${code ?? "unknown error"})`,
    );
  }
  try {
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || opened.dev !== seen.dev || opened.ino !== seen.ino) {
      throw new Refusal(`source ${path} changed while it was read`);
    }
    if (opened.size > limits.fileBytes) {
      throw new Refusal(`source ${path} is larger than ${limits.fileBytes} bytes`);
    }
    const bytes = new Uint8Array(readFileSync(descriptor));
    if (bytes.byteLength !== opened.size) {
      throw new Refusal(`source ${path} changed while it was read`);
    }
    return bytes;
  } finally {
    closeSync(descriptor);
  }
}

function mediaTypeOverrides(
  values: readonly string[],
  files: readonly SourceFile[],
): Map<string, string> {
  const overrides = new Map<string, string>();
  for (const value of values) {
    const separator = value.lastIndexOf("=");
    const path = value.slice(0, separator);
    const mediaType = value.slice(separator + 1);
    if (separator <= 0 || mediaType === "") {
      throw new Refusal(`--media-type ${JSON.stringify(value)} must be <path>=<type>`);
    }
    if (!files.some((file) => file.path === path)) {
      throw new Refusal(`--media-type names ${path}, which is not in the source`);
    }
    overrides.set(path, mediaType);
  }
  return overrides;
}

function entrypointFor(
  profile: FormProfile,
  requested: string | undefined,
  files: readonly { readonly path: string; readonly mediaType: string }[],
): string {
  const modules = files.filter((file) => file.mediaType === profile.entrypointMediaType);
  if (requested !== undefined) {
    if (!modules.some((file) => file.path === requested)) {
      throw new Refusal(
        `--entrypoint ${requested} is not a ${profile.entrypointMediaType} file in the source`,
      );
    }
    return requested;
  }
  if (modules.length === 1) return (modules[0] as { path: string }).path;
  throw new Refusal(
    `the source has ${modules.length} module files; pass --entrypoint <path> to name the Worker's main module`,
  );
}

async function formValidation(
  profile: FormProfile,
  input: Parameters<FormProfile["validate"]>[0],
): ReturnType<FormProfile["validate"]> {
  try {
    return await profile.validate(input);
  } catch (error) {
    if (error instanceof profile.validationError) {
      throw new Refusal(`the ${profile.title} Form rejects these files (${error.code})`);
    }
    throw error;
  }
}

export function heldObjectKey(sha256: string): string {
  return `${HELD_OBJECT_PREFIX}${sha256}`;
}

/** Content-addressed and create-only: an existing object must already hold these bytes. */
async function storeHeldObject(
  objects: ObjectStore,
  digest: string,
  bytes: Uint8Array,
): Promise<boolean> {
  const key = heldObjectKey(digest);
  if (await objects.create(key, bytes, { contentType: "application/octet-stream" })) return true;
  const existing = await objects.get(key);
  const held = existing ? new Uint8Array(await new Response(existing.body).arrayBuffer()) : null;
  if (!held || hexDigest(held) !== digest) {
    throw new Refusal(
      `objects/${key} exists but does not hold the bytes its name promises; ` +
        "move it aside (with the Host stopped) and seed again",
    );
  }
  return false;
}

interface PreparedConfig {
  readonly path: string;
  readonly targetKey: string;
  readonly entryCount: number;
  readonly notes: readonly string[];
  write(): void;
}

function readConfigFile(path: string): string {
  const metadata = lstatSync(path, { throwIfNoEntry: false });
  if (!metadata?.isFile()) {
    throw new Refusal(`config ${path} must be an existing regular file, not a symbolic link`);
  }
  return readFileSync(path, "utf8");
}

function parseConfigText(text: string, name: string) {
  try {
    return parseTakoformV2PublicConfig(text);
  } catch (error) {
    if (error instanceof V2ApplicationConfigError) {
      throw new Refusal(`${name} is not a valid TAKOSERVER_TAKOFORM_V2_CONFIG (${error.code})`);
    }
    throw error;
  }
}

/** The bytes `NAME=value` takes in the environment block, with its terminator. */
function environmentBytes(text: string): number {
  return new TextEncoder().encode(`TAKOSERVER_TAKOFORM_V2_CONFIG=${text.trimEnd()}`).byteLength + 1;
}

/**
 * Merge into the operator's config file. Everything is validated now, before
 * any object is written; the file is replaced only after the bytes are held,
 * and only if it still holds exactly what was read here.
 */
function prepareConfigMerge(
  path: string,
  profile: FormProfile,
  explicitTargetKey: string | undefined,
  entries: readonly V2HeldArtifactEntry[],
  options: { readonly addGrants: boolean },
): PreparedConfig {
  const text = readConfigFile(path);
  parseConfigText(text, path);
  const directory = dirname(path);
  try {
    // The file is replaced by a rename, so its directory must be writable.
    accessSync(directory, constants.W_OK | constants.X_OK);
  } catch {
    throw new Refusal(
      `cannot write ${directory}: --config replaces ${basename(path)} through a temporary file in its directory, ` +
        "so this user needs write access to the directory (for example a directory such as /etc/takoserver/v2 owned by the Host's user)",
    );
  }
  const raw = JSON.parse(text) as Record<string, unknown>;
  const existing = raw[profile.block] as
    | { targetKey: string; heldArtifacts: V2HeldArtifactEntry[] }
    | undefined;
  if (existing && explicitTargetKey !== undefined && explicitTargetKey !== existing.targetKey) {
    throw new Refusal(
      `${path} already has ${profile.block} with targetKey ${existing.targetKey}; ` +
        "an existing target is never changed here (drop --target-key)",
    );
  }
  const targetKey = existing?.targetKey ?? explicitTargetKey ?? profile.defaultTargetKey;
  const heldArtifacts: V2HeldArtifactEntry[] = (existing?.heldArtifacts ?? []).map((entry) => ({
    ...entry,
    grants: entry.grants.map((grant) => ({ ...grant })),
  }));
  const widened = new Set<string>();
  for (const entry of entries) {
    const found = heldArtifacts.find(
      (held) => held.url === entry.url && held.sha256 === entry.sha256,
    );
    if (!found) {
      heldArtifacts.push({ ...entry, grants: entry.grants.map((grant) => ({ ...grant })) });
      continue;
    }
    if (found.objectKey !== entry.objectKey) {
      throw new Refusal(
        `${path} already maps ${entry.url} to object ${found.objectKey}, not ${entry.objectKey}`,
      );
    }
    const grants = found.grants as V2HeldArtifactGrant[];
    for (const grant of entry.grants) {
      if (
        !grants.some((held) => held.principal === grant.principal && held.space === grant.space)
      ) {
        widened.add(grant.principal);
        grants.push({ ...grant });
      }
    }
  }
  if (widened.size > 0 && !options.addGrants) {
    throw new Refusal(
      `${path} already holds these artifacts for other organizations; pass --add-grants to also grant them to ${[...widened].join(", ")}`,
    );
  }
  const merged = { ...raw, [profile.block]: { targetKey, heldArtifacts } };
  // One line: the Host receives this file's contents as one environment variable.
  const nextText = `${JSON.stringify(merged)}\n`;
  const next = parseConfigText(nextText, `${path} after merging`);
  const size = environmentBytes(nextText);
  if (size > LINUX_ENVIRONMENT_STRING_MAX_BYTES) {
    throw new Refusal(
      `${path} would be ${size} bytes as TAKOSERVER_TAKOFORM_V2_CONFIG; Linux passes at most ${LINUX_ENVIRONMENT_STRING_MAX_BYTES} bytes in one environment variable, so the Host could not start with it. ` +
        "Remove the entries of artifacts whose Resources have all been created (see docs/self-host-operations.md), then seed again",
    );
  }
  const workerKey = next.workerBundle?.targetKey;
  const assetKey = next.staticAssetBundle?.targetKey;
  const notes: string[] = [];
  if (
    profile.block !== "sqliteMigrationSet" &&
    (workerKey !== SELFHOST_V2_WORKER_TARGET_KEY || assetKey !== SELFHOST_V2_WORKER_TARGET_KEY)
  ) {
    notes.push(
      `note: the complete local Worker profile needs both workerBundle and staticAssetBundle on target ${SELFHOST_V2_WORKER_TARGET_KEY} (an empty heldArtifacts list is enough for the other one)`,
    );
  }
  if (widened.size > 0) {
    notes.push(`added grants for ${[...widened].join(", ")} to existing entries`);
  }
  return {
    path,
    targetKey,
    entryCount: heldArtifacts.length,
    notes,
    write() {
      const temporary = join(directory, `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
      try {
        // Compare and swap: a concurrent seed's update is never silently dropped.
        if (readFileSync(path, "utf8") !== text) {
          throw new Error("it changed since this command read it; nothing was written to it");
        }
        const mode = (lstatSync(path).mode & 0o777) | 0;
        writeFileSync(temporary, nextText, { mode, flag: "wx" });
        chmodSync(temporary, mode);
        renameSync(temporary, path);
      } catch (error) {
        rmSync(temporary, { force: true });
        throw new Error(
          `the held bytes are in place, but ${path} was not updated (${error instanceof Error ? error.message : "unknown error"}); ` +
            "seed again to merge into its current contents, or add the printed configFragment by hand",
        );
      }
    },
  };
}

function hexDigest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

if (import.meta.main) {
  process.exitCode = await runSelfhostArtifactCli(process.argv.slice(2));
}
