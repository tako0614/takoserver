import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
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
 *     [--entrypoint worker.js] [--media-type <path>=<type> ...]
 *     [--target-key KEY] [--config FILE] [--data-root DIR]
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
 * by this user and private (the rule the v2 private planes use), without a
 * control database, or open in any other process (a running Host keeps its
 * control database open; on Linux every process's descriptors are checked), an
 * organization the control database does not know, and any input the Form
 * would reject. The Host reads held artifacts only at startup, so a seed is
 * always followed by a restart with the updated configuration.
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
  "         [--entrypoint <path>] [--media-type <path>=<type> ...] [--target-key <key>]\n" +
  "         [--config <file>] [--data-root <dir>]\n" +
  "       selfhost-artifact.ts verify [--config <file>] [--data-root <dir>]\n";

const SEED_FLAGS = [
  "base-url",
  "organization",
  "entrypoint",
  "media-type",
  "target-key",
  "config",
  "data-root",
] as const;
const VERIFY_FLAGS = ["config", "data-root"] as const;
const REPEATABLE_FLAGS = new Set(["organization", "media-type"]);

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
    const value = args[index + 1];
    if (!allowed.includes(name) || value === undefined) return null;
    const values = flags.get(name) ?? [];
    if (values.length > 0 && !REPEATABLE_FLAGS.has(name)) return null;
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
  const installation = stoppedInstallation(single(flags, "data-root"), io);
  const unknown = unknownOrganizations(installation.databasePath, organizations);
  if (unknown.length > 0) {
    throw new Refusal(
      `${installation.databasePath} has no organization ${unknown.map((id) => JSON.stringify(id)).join(", ")}; ` +
        "create it first (POST /v1/organizations) or check the id in GET /v1/me",
    );
  }

  // Everything the Host would refuse is refused here, before any byte is written.
  const files = readSourceTree(resolve(io.cwd, sourceDirectory), profile.limits);
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
    ? prepareConfigMerge(resolve(io.cwd, configPath), profile, explicitTargetKey, entries)
    : undefined;
  const targetKey = config?.targetKey ?? explicitTargetKey ?? profile.defaultTargetKey;
  const configFragment = { [profile.block]: { targetKey, heldArtifacts: entries } };
  // The fragment on its own is exactly what the Host's strict startup parser accepts.
  parseConfigText(
    JSON.stringify({
      documentation: "https://example.invalid/",
      authenticationDocumentation: "https://example.invalid/",
      ...configFragment,
    }),
    "the generated configuration fragment",
  );

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
    `create it with form ${profile.url} and spec ${JSON.stringify({ artifact })}`,
    config
      ? `updated ${config.path}: ${profile.block} now holds ${config.entryCount} held artifact(s)`
      : `add configFragment.${profile.block}.heldArtifacts to TAKOSERVER_TAKOFORM_V2_CONFIG (target ${targetKey}), or pass --config <file>`,
    ...(config?.notes ?? []),
    "then restart the Host with that configuration: it reads held artifacts only at startup",
  ];
  if (configProblem) {
    io.stderr(`selfhost-artifact: ${configProblem}\n`);
    return 1;
  }
  io.stderr(`${lines.join("\n")}\n`);
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

interface Installation {
  readonly dataRoot: string;
  readonly databasePath: string;
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

/** The data root of an installation that has booted once and is not running now. */
function stoppedInstallation(flag: string | undefined, io: SelfhostArtifactCliIo): Installation {
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
  const holders = dataRootHolders({
    procRoot: io.procRoot,
    dataRoot,
    // Descriptors name the real file, so compare against its canonical path.
    files: [realpathSync(databasePath)],
    selfPid: process.pid,
  });
  if (holders === "unprovable") {
    throw new Refusal(
      `cannot prove that no Host is running: ${io.procRoot} does not show this process's open files (seeding needs Linux /proc)`,
    );
  }
  if (holders.length > 0) {
    const listed = holders
      .slice(0, MAX_LISTED_HOLDERS)
      .map((holder) => `pid ${holder.pid} has ${holder.path} open`)
      .join("; ");
    throw new Refusal(
      `${dataRoot} is in use (${listed}${holders.length > MAX_LISTED_HOLDERS ? "; ..." : ""}). ` +
        "Stop the Host and every other process using this data root, then seed again",
    );
  }
  return { dataRoot, databasePath };
}

export interface DataRootHolder {
  readonly pid: number;
  readonly path: string;
}

/**
 * Every other process with a file at or below `dataRoot`, or one of `files`,
 * open. A running Host keeps its control database open for its whole life.
 * `unprovable` when the process table does not show this process's own
 * descriptors, so an empty answer would mean nothing.
 */
export function dataRootHolders(input: {
  readonly procRoot: string;
  readonly dataRoot: string;
  readonly files: readonly string[];
  readonly selfPid: number;
}): DataRootHolder[] | "unprovable" {
  let processes: string[];
  try {
    processes = readdirSync(input.procRoot);
    readdirSync(join(input.procRoot, String(input.selfPid), "fd"));
  } catch {
    return "unprovable";
  }
  const prefix = input.dataRoot.endsWith("/") ? input.dataRoot : `${input.dataRoot}/`;
  const holders: DataRootHolder[] = [];
  for (const entry of processes) {
    if (!/^[0-9]+$/u.test(entry) || Number(entry) === input.selfPid) continue;
    let descriptors: string[];
    try {
      descriptors = readdirSync(join(input.procRoot, entry, "fd"));
    } catch {
      // Exited while scanning, or another user's process: such a process
      // cannot open anything inside a root private to this user.
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
  return holders;
}

function unknownOrganizations(databasePath: string, organizations: readonly string[]): string[] {
  let database: Database | undefined;
  try {
    database = new Database(databasePath, { readonly: true });
    database.exec("PRAGMA busy_timeout = 1000");
    const query = database.query("SELECT 1 AS found FROM orgs WHERE id = ?");
    return organizations.filter((organization) => query.get(organization) === null);
  } catch (error) {
    throw new Refusal(
      `cannot read organizations from ${databasePath} (${error instanceof Error ? error.message : "unknown error"}); ` +
        "start and stop the Host once so it brings the control database up to date",
    );
  } finally {
    database?.close();
  }
}

interface SourceFile {
  readonly path: string;
  readonly bytes: Uint8Array;
}

/** Every regular file below `directory`, in byte order of its relative path. */
function readSourceTree(directory: string, limits: Limits): SourceFile[] {
  if (!lstatSync(directory, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Refusal(`source ${directory} must be a directory, not a symbolic link or a file`);
  }
  const files: SourceFile[] = [];
  let totalBytes = 0;
  const walk = (absolute: string, relative: string): void => {
    for (const name of readdirSync(absolute)) {
      const path = relative ? `${relative}/${name}` : name;
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
      if (metadata.size > limits.fileBytes) {
        throw new Refusal(`source ${path} is larger than ${limits.fileBytes} bytes`);
      }
      totalBytes += metadata.size;
      if (totalBytes > limits.aggregateBytes) {
        throw new Refusal(`source files are larger than ${limits.aggregateBytes} bytes together`);
      }
      files.push({ path, bytes: new Uint8Array(readFileSync(child)) });
    }
  };
  walk(directory, "");
  if (files.length === 0) throw new Refusal(`source ${directory} has no files`);
  const encoder = new TextEncoder();
  return files.sort((left, right) =>
    Buffer.compare(encoder.encode(left.path), encoder.encode(right.path)),
  );
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

/** Merge into the operator's config file; validated now, written only after the bytes are held. */
function prepareConfigMerge(
  path: string,
  profile: FormProfile,
  explicitTargetKey: string | undefined,
  entries: readonly V2HeldArtifactEntry[],
): PreparedConfig {
  const text = readConfigFile(path);
  parseConfigText(text, path);
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
        grants.push({ ...grant });
      }
    }
  }
  const merged = { ...raw, [profile.block]: { targetKey, heldArtifacts } };
  // One line: the Host receives this file's contents as one environment variable.
  const nextText = `${JSON.stringify(merged)}\n`;
  const next = parseConfigText(nextText, `${path} after merging`);
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
  const environmentBytes =
    new TextEncoder().encode(`TAKOSERVER_TAKOFORM_V2_CONFIG=${nextText.trimEnd()}`).byteLength + 1;
  if (environmentBytes > LINUX_ENVIRONMENT_STRING_MAX_BYTES) {
    notes.push(
      `warning: ${path} is now ${environmentBytes} bytes as TAKOSERVER_TAKOFORM_V2_CONFIG; Linux passes at most ${LINUX_ENVIRONMENT_STRING_MAX_BYTES} bytes in one environment variable, so the Host cannot be started with it`,
    );
  }
  return {
    path,
    targetKey,
    entryCount: heldArtifacts.length,
    notes,
    write() {
      const mode = (lstatSync(path).mode & 0o777) | 0;
      const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.tmp`);
      try {
        writeFileSync(temporary, nextText, { mode, flag: "wx" });
        chmodSync(temporary, mode);
        renameSync(temporary, path);
      } catch (error) {
        rmSync(temporary, { force: true });
        throw new Error(
          `the held bytes are in place, but ${path} could not be updated (${error instanceof Error ? error.message : "unknown error"}); ` +
            "add the printed configFragment by hand",
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
