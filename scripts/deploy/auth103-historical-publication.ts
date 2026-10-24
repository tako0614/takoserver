import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { canonicalJson } from "../../src/json.ts";
import { type DeployPhase, preflightError, verificationError } from "./errors.ts";
import { readAuth103OriginalCustodyDirectory } from "./schema-auth103-native-source.ts";

const INDEX = "auth103-historical-publication.json";
const PROOF = "auth103-historical-publication";
/** Independently reviewed byte index for one retained original publication.
 * This witness authorizes only historical Version module-byte comparison. */
const REVIEWED_INDEX_DIGEST =
  "sha256:a7de49fc07acd30f004c365366bd1e69d70b5ba58e116b8803e0fe85485908cb";
const FILES = [
  "BUILD.ts",
  "BUILD-RESULT-v5.json",
  "SEAM-PROBE-v2.ts",
  "SEAM-PROBE-RESULT-v2.json",
  "release/worker.js",
  "release/auth103-source-install.sql",
  "release/wrangler.jsonc",
] as const;
const SOURCE = /^[0-9a-f]{40}$/u;
const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const VERSION = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const MAX = new Map<string, number>([
  [INDEX, 8192],
  ["BUILD.ts", 16 * 1024],
  ["BUILD-RESULT-v5.json", 4096],
  ["SEAM-PROBE-v2.ts", 8192],
  ["SEAM-PROBE-RESULT-v2.json", 4096],
  ["release/worker.js", 16 * 1024 * 1024],
  ["release/auth103-source-install.sql", 128 * 1024],
  ["release/wrangler.jsonc", 128 * 1024],
]);
const hash = (bytes: Uint8Array | string) =>
  `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

type Phase = Extract<DeployPhase, "preflight" | "verification">;
type FileName = (typeof FILES)[number];

function refuse(phase: Phase, message: string): never {
  throw phase === "preflight" ? preflightError(message) : verificationError(message);
}

function record(value: unknown, phase: Phase): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    refuse(phase, "Auth103 historical publication record is malformed");
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, keys: readonly string[], phase: Phase): void {
  if (JSON.stringify(Object.keys(value)) !== JSON.stringify(keys))
    refuse(phase, "Auth103 historical publication record has an unexpected shape");
}

function json(bytes: Buffer, phase: Phase): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    refuse(phase, "Auth103 historical publication JSON is malformed");
  }
  const value = record(parsed, phase);
  if (!bytes.equals(Buffer.from(`${JSON.stringify(value, null, 2)}\n`)))
    refuse(phase, "Auth103 historical publication JSON differs from its writer format");
  return value;
}

function directory(path: string, expected: readonly string[], phase: Phase): () => void {
  const before = lstatSync(path, { bigint: true });
  if (
    !before.isDirectory() ||
    before.isSymbolicLink() ||
    (before.mode & 0o777n) !== 0o700n ||
    (typeof process.getuid === "function" && before.uid !== BigInt(process.getuid())) ||
    realpathSync(path) !== path ||
    JSON.stringify(readdirSync(path).sort()) !== JSON.stringify([...expected].sort())
  )
    refuse(phase, "Auth103 historical publication directory is not sealed");
  return () => {
    const after = lstatSync(path, { bigint: true });
    if (
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.mode !== before.mode ||
      after.mtimeNs !== before.mtimeNs ||
      after.ctimeNs !== before.ctimeNs ||
      JSON.stringify(readdirSync(path).sort()) !== JSON.stringify([...expected].sort())
    )
      refuse(phase, "Auth103 historical publication directory changed during read");
  };
}

function file(path: string, name: FileName | typeof INDEX, phase: Phase) {
  const before = lstatSync(path, { bigint: true });
  const limit = MAX.get(name);
  if (
    limit === undefined ||
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.nlink !== 1n ||
    (before.mode & 0o777n) !== 0o600n ||
    (typeof process.getuid === "function" && before.uid !== BigInt(process.getuid())) ||
    before.size === 0n ||
    before.size > BigInt(limit) ||
    realpathSync(path) !== path
  )
    refuse(phase, "Auth103 historical publication file is not owned and bounded");
  const bytes = readFileSync(path);
  const after = lstatSync(path, { bigint: true });
  const same = (current: typeof before) =>
    current.dev === before.dev &&
    current.ino === before.ino &&
    current.mode === before.mode &&
    current.nlink === before.nlink &&
    current.size === before.size &&
    current.mtimeNs === before.mtimeNs &&
    current.ctimeNs === before.ctimeNs;
  if (!same(after) || BigInt(bytes.length) !== before.size)
    refuse(phase, "Auth103 historical publication file changed during read");
  return {
    bytes,
    assertUnchanged() {
      if (!same(lstatSync(path, { bigint: true })) || !readFileSync(path).equals(bytes))
        refuse(phase, "Auth103 historical publication file changed during read");
    },
  };
}

export interface HistoricalPublicationSelection {
  readonly phase: Phase;
  readonly target: {
    readonly workerName: string;
    readonly accountId: string;
    readonly d1: { readonly databaseName: string; readonly databaseId: string };
    readonly r2: { readonly bucketName: string };
  };
  /** Digest of the exact selected private descriptor's raw bytes. */
  readonly targetDigest: string;
  readonly sourceCommit: string;
  readonly versionId: string;
  readonly deploymentId: string;
}

/** Mechanical equality for the retained config's selected storage resources. */
export function historicalResourceBindingsMatch(
  config: Record<string, unknown>,
  target: HistoricalPublicationSelection["target"],
): boolean {
  return (
    canonicalJson(config.d1_databases) ===
      canonicalJson([
        {
          binding: "STATE_DB",
          database_name: target.d1.databaseName,
          database_id: target.d1.databaseId,
        },
      ]) &&
    canonicalJson(config.r2_buckets) ===
      canonicalJson([{ binding: "OBJECTS", bucket_name: target.r2.bucketName }])
  );
}

/** Retained original publication DATA, never a native source or upload grant. */
export function readAuth103HistoricalPublication(input: HistoricalPublicationSelection): {
  readonly worker: Buffer;
  readonly sql: Buffer;
  readonly assertUnchanged: () => void;
} | null {
  const { phase } = input;
  if (process.env.TAKOSERVER_AUTH103_INSTALL_CUSTODY_DIRECTORY === undefined) return null;
  try {
    const custody = readAuth103OriginalCustodyDirectory();
    const indexPath = join(custody.path, INDEX);
    let indexFile: ReturnType<typeof file>;
    try {
      indexFile = file(indexPath, INDEX, phase);
    } catch (error) {
      if (
        error !== null &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        custody.assertUnchanged();
        return null;
      }
      throw error;
    }
    if (hash(indexFile.bytes) !== REVIEWED_INDEX_DIGEST)
      refuse(phase, "Auth103 historical publication index is not the reviewed original");
    const index = json(indexFile.bytes, phase);
    exact(index, ["kind", "versionId", "deploymentId", "files"], phase);
    if (
      index.kind !== "takoserver.auth103-historical-publication-index@v1" ||
      typeof index.versionId !== "string" ||
      !VERSION.test(index.versionId) ||
      typeof index.deploymentId !== "string" ||
      index.deploymentId.length === 0
    )
      refuse(phase, "Auth103 historical publication index is malformed");
    const entries = record(index.files, phase);
    exact(entries, FILES, phase);
    for (const name of FILES) {
      const entry = record(entries[name], phase);
      exact(entry, ["bytes", "digest"], phase);
      const limit = MAX.get(name);
      if (
        limit === undefined ||
        !Number.isSafeInteger(entry.bytes) ||
        (entry.bytes as number) <= 0 ||
        (entry.bytes as number) > limit ||
        typeof entry.digest !== "string" ||
        !DIGEST.test(entry.digest)
      )
        refuse(phase, "Auth103 historical publication index file binding is malformed");
    }
    const proof = join(custody.path, PROOF);
    const proofUnchanged = directory(
      proof,
      [
        "BUILD.ts",
        "BUILD-RESULT-v5.json",
        "SEAM-PROBE-v2.ts",
        "SEAM-PROBE-RESULT-v2.json",
        "release",
      ],
      phase,
    );
    const releaseUnchanged = directory(
      join(proof, "release"),
      ["worker.js", "auth103-source-install.sql", "wrangler.jsonc"],
      phase,
    );
    const retained = new Map<FileName, ReturnType<typeof file>>();
    for (const name of FILES) {
      const saved = file(join(proof, name), name, phase);
      const entry = entries[name] as { readonly bytes: number; readonly digest: string };
      if (saved.bytes.length !== entry.bytes || hash(saved.bytes) !== entry.digest)
        refuse(phase, "Auth103 historical publication bytes differ from their index");
      retained.set(name, saved);
    }
    const saved = (name: FileName) => {
      const value = retained.get(name);
      if (value === undefined)
        refuse(phase, "Auth103 historical publication inventory is incomplete");
      return value;
    };
    if (index.versionId !== input.versionId) {
      for (const name of FILES) saved(name).assertUnchanged();
      releaseUnchanged();
      proofUnchanged();
      indexFile.assertUnchanged();
      custody.assertUnchanged();
      return null;
    }
    if (
      index.deploymentId !== input.deploymentId ||
      !SOURCE.test(input.sourceCommit) ||
      !/^[0-9a-f]{64}$/u.test(input.targetDigest)
    )
      refuse(phase, "Auth103 historical publication selection differs from live history");
    const bytes = (name: FileName) => saved(name).bytes;
    const build = bytes("BUILD.ts").toString("utf8");
    const receipt = json(bytes("BUILD-RESULT-v5.json"), phase);
    exact(
      receipt,
      [
        "kind",
        "status",
        "sourceCommit",
        "targetDigest",
        "releaseInventory",
        "bundleDigest",
        "bundleBytes",
        "installSqlDigest",
        "installSqlBytes",
        "installSqlRecomposedFromOriginal",
      ],
      phase,
    );
    const probe = bytes("SEAM-PROBE-v2.ts").toString("utf8");
    const probeReceipt = json(bytes("SEAM-PROBE-RESULT-v2.json"), phase);
    exact(probeReceipt, ["status", "originalBuilderMatchesIndependentLocalRelease"], phase);
    const worker = bytes("release/worker.js");
    const sql = bytes("release/auth103-source-install.sql");
    const workerDigest = hash(worker);
    const sqlDigest = hash(sql);
    if (
      receipt.kind !== "takoserver.auth103-historical-original-local-build@v1" ||
      receipt.status !== "source-qualified" ||
      receipt.sourceCommit !== input.sourceCommit ||
      receipt.targetDigest !== input.targetDigest ||
      JSON.stringify(receipt.releaseInventory) !==
        JSON.stringify(["auth103-source-install.sql", "worker.js", "wrangler.jsonc"]) ||
      receipt.bundleDigest !== workerDigest ||
      receipt.bundleBytes !== worker.length ||
      receipt.installSqlDigest !== sqlDigest ||
      receipt.installSqlBytes !== sql.length ||
      receipt.installSqlRecomposedFromOriginal !== true ||
      probeReceipt.status !== "source-qualified" ||
      probeReceipt.originalBuilderMatchesIndependentLocalRelease !== true ||
      !build.includes(`const COMMIT = "${input.sourceCommit}";`) ||
      !build.includes(`const TARGET_DIGEST = "${input.targetDigest}";`) ||
      !build.includes("prepareWorkerArtifact({") ||
      !build.includes("createAuth103NativeSourceInstallContribution(") ||
      !probe.includes(`const commit = "${input.sourceCommit}";`) ||
      !probe.includes(
        "originalAuth103ModuleDigests(buildAuth103OriginalWorkerModules(target, commit))",
      ) ||
      !probe.includes(`result.worker !== "${workerDigest.slice(7)}"`) ||
      !probe.includes(`result.sql !== "${sqlDigest.slice(7)}"`)
    )
      refuse(phase, "Auth103 historical publication original proof is unqualified");
    let configValue: unknown;
    try {
      configValue = JSON.parse(bytes("release/wrangler.jsonc").toString("utf8"));
    } catch {
      refuse(phase, "Auth103 historical publication config is malformed");
    }
    const config = record(configValue, phase);
    const vars = record(config.vars, phase);
    const define = record(config.define, phase);
    exact(
      define,
      ["__TAKOSERVER_AUTH103_NATIVE_SOURCE__", "__TAKOSERVER_AUTH103_NATIVE_PROFILE__"],
      phase,
    );
    let manifestValue: unknown;
    let profileValue: unknown;
    try {
      manifestValue = JSON.parse(String(define.__TAKOSERVER_AUTH103_NATIVE_SOURCE__));
      profileValue = JSON.parse(String(define.__TAKOSERVER_AUTH103_NATIVE_PROFILE__));
    } catch {
      refuse(phase, "Auth103 historical publication native define is malformed");
    }
    const manifest = record(manifestValue, phase);
    const expectedTargetRef = hash(
      canonicalJson([
        "takoserver.auth103.native-state-db.v1",
        input.target.accountId,
        input.target.d1.databaseId,
      ]),
    );
    if (
      config.name !== input.target.workerName ||
      config.account_id !== input.target.accountId ||
      config.main !== "worker.js" ||
      Object.hasOwn(config, "find_additional_modules") ||
      !historicalResourceBindingsMatch(config, input.target) ||
      vars.TAKOSERVER_SOURCE_COMMIT !== input.sourceCommit ||
      vars.TAKOSERVER_WORKER_ARTIFACT_DIGEST !== workerDigest ||
      profileValue !== "root-shared-auth-staging-v1" ||
      manifest.version !== 1 ||
      manifest.sourceCommit !== input.sourceCommit ||
      manifest.targetRef !== expectedTargetRef ||
      typeof manifest.sourceRef !== "string" ||
      !DIGEST.test(manifest.sourceRef) ||
      worker.toString("utf8").split(manifest.sourceRef).length !== 2 ||
      !sql.includes(Buffer.from(manifest.sourceRef)) ||
      !sql.includes(Buffer.from(expectedTargetRef)) ||
      !sql.includes(Buffer.from(workerDigest))
    )
      refuse(phase, "Auth103 historical publication release differs from its selected source");
    const assertUnchanged = () => {
      for (const name of FILES) saved(name).assertUnchanged();
      releaseUnchanged();
      proofUnchanged();
      indexFile.assertUnchanged();
      custody.assertUnchanged();
    };
    assertUnchanged();
    return { worker, sql, assertUnchanged };
  } catch (error) {
    if (error instanceof Error && "phase" in error && error.phase === phase) throw error;
    return refuse(phase, "Auth103 historical publication custody is unavailable");
  }
}
