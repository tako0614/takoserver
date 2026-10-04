import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  writeSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { mutationError, preflightError } from "./errors.ts";
import { REPOSITORY } from "./process.ts";

const MAX_RECORD_BYTES = 8192;
const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const DATABASE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const STAGES = ["intent", "identified", "import-dispatched", "complete"] as const;
type Stage = (typeof STAGES)[number];

/** One fresh-generation authority binding, never an existing-target migration proof. */
export interface FreshD1AttemptBinding {
  readonly accountId: string;
  readonly generation: string;
  readonly databaseName: string;
  readonly incumbentDatabaseName: string;
  readonly incumbentDatabaseId: string;
  readonly incumbentBucketName: string;
  readonly workerName: string;
  readonly sourceCommit: string;
  readonly migrationDigest: string;
  readonly migrationBytes: number;
  readonly importDigest: string;
  readonly importBytes: number;
  readonly applicationShapeDigest: string;
}

interface AttemptRecord {
  readonly kind: "takoserver.production-d1-fresh-attempt@v1";
  readonly stage: Stage;
  readonly binding: FreshD1AttemptBinding;
  readonly previousDigest?: string;
  readonly databaseId?: string;
  readonly digest: string;
}

export interface FreshD1Attempt {
  readonly intent: AttemptRecord;
  readonly identified: AttemptRecord | null;
  readonly importDispatched: AttemptRecord | null;
  readonly complete: AttemptRecord | null;
}

export interface FreshD1Custody {
  readonly root: string;
  assertContinuity(): void;
  read(binding: FreshD1AttemptBinding): FreshD1Attempt | null;
  persistIntent(binding: FreshD1AttemptBinding): AttemptRecord;
  persistIdentified(binding: FreshD1AttemptBinding, databaseId: string): AttemptRecord;
  persistImportDispatched(binding: FreshD1AttemptBinding): AttemptRecord;
  persistComplete(binding: FreshD1AttemptBinding): AttemptRecord;
}

function digest(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

/** The root is operator-provisioned custody, never a temporary build output. */
export function openFreshD1Custody(
  root: string,
  accountId: string,
  generation: string,
): FreshD1Custody {
  if (!isAbsolute(root) || root === "/" || root.endsWith("/")) {
    throw preflightError("fresh D1 attempt custody requires one absolute private directory");
  }
  const identity = safeRootIdentity(root);
  const prefix = join(root, `fresh-d1-${digest(`${accountId}\0${generation}`).slice(7)}`);
  const path = (stage: Stage) => `${prefix}.${stage}.json`;
  const assertContinuity = (): void => {
    const current = safeRootIdentity(root);
    if (current.device !== identity.device || current.inode !== identity.inode) {
      throw mutationError("fresh D1 attempt custody root changed; prior dispatch is unknown");
    }
  };
  const read = (binding: FreshD1AttemptBinding): FreshD1Attempt | null => {
    assertContinuity();
    const intent = readRecord(path("intent"), "intent", binding);
    const identified = readRecord(path("identified"), "identified", binding);
    const importDispatched = readRecord(path("import-dispatched"), "import-dispatched", binding);
    const complete = readRecord(path("complete"), "complete", binding);
    if (intent === null) {
      if (identified !== null || importDispatched !== null || complete !== null) {
        throw mutationError("fresh D1 attempt custody is partial; prior dispatch is unknown");
      }
      return null;
    }
    if (
      identified !== null &&
      (identified.previousDigest !== intent.digest ||
        typeof identified.databaseId !== "string" ||
        !DATABASE_ID.test(identified.databaseId))
    ) {
      throw mutationError("fresh D1 identified attempt does not follow its durable intent");
    }
    if (
      importDispatched !== null &&
      (identified === null ||
        importDispatched.previousDigest !== identified.digest ||
        importDispatched.databaseId !== identified.databaseId)
    ) {
      throw mutationError("fresh D1 import attempt does not follow its identified database");
    }
    if (
      complete !== null &&
      (importDispatched === null ||
        complete.previousDigest !== importDispatched.digest ||
        complete.databaseId !== importDispatched.databaseId)
    ) {
      throw mutationError("fresh D1 completion does not follow its import attempt");
    }
    return { intent, identified, importDispatched, complete };
  };
  const write = (
    stage: Stage,
    binding: FreshD1AttemptBinding,
    previousDigest?: string,
    databaseId?: string,
  ): AttemptRecord => {
    assertContinuity();
    const body = {
      kind: "takoserver.production-d1-fresh-attempt@v1" as const,
      stage,
      binding,
      ...(previousDigest === undefined ? {} : { previousDigest }),
      ...(databaseId === undefined ? {} : { databaseId }),
    };
    const record = { ...body, digest: digest(JSON.stringify(body)) };
    const bytes = Buffer.from(`${JSON.stringify(record)}\n`, "utf8");
    if (bytes.length > MAX_RECORD_BYTES)
      throw preflightError("fresh D1 attempt record is too large");
    let directory = -1;
    let descriptor = -1;
    try {
      directory = openSync(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      descriptor = openSync(
        path(stage),
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      fchmodSync(descriptor, 0o600);
      let offset = 0;
      while (offset < bytes.length) {
        const written = writeSync(descriptor, bytes, offset, bytes.length - offset);
        if (written < 1) throw new Error("short write");
        offset += written;
      }
      fsyncSync(descriptor);
      fsyncSync(directory);
      assertContinuity();
    } catch {
      throw mutationError(
        "fresh D1 attempt could not be durably recorded; do not retry this generation",
      );
    } finally {
      if (descriptor >= 0) closeSync(descriptor);
      if (directory >= 0) closeSync(directory);
    }
    return record;
  };
  return {
    root,
    assertContinuity,
    read,
    persistIntent(binding) {
      if (read(binding) !== null)
        throw mutationError("fresh D1 generation has prior attempt custody");
      return write("intent", binding);
    },
    persistIdentified(binding, databaseId) {
      if (!DATABASE_ID.test(databaseId)) throw mutationError("fresh D1 identity is malformed");
      const prior = read(binding);
      if (prior === null || prior.identified !== null) {
        throw mutationError("fresh D1 identified attempt has no sole preceding intent");
      }
      return write("identified", binding, prior.intent.digest, databaseId);
    },
    persistImportDispatched(binding) {
      const prior = read(binding);
      if (
        prior?.identified === null ||
        prior?.identified === undefined ||
        prior.importDispatched !== null
      ) {
        throw mutationError("fresh D1 import attempt has no sole identified predecessor");
      }
      return write(
        "import-dispatched",
        binding,
        prior.identified.digest,
        prior.identified.databaseId,
      );
    },
    persistComplete(binding) {
      const prior = read(binding);
      if (
        prior?.importDispatched === null ||
        prior?.importDispatched === undefined ||
        prior.complete !== null
      ) {
        throw mutationError("fresh D1 completion has no sole import predecessor");
      }
      return write(
        "complete",
        binding,
        prior.importDispatched.digest,
        prior.importDispatched.databaseId,
      );
    },
  };
}

function safeRootIdentity(root: string): { readonly device: bigint; readonly inode: bigint } {
  try {
    const state = lstatSync(root, { bigint: true });
    const physical = realpathSync(root);
    const inside = relative(realpathSync(REPOSITORY), physical);
    if (
      physical !== root ||
      !state.isDirectory() ||
      state.isSymbolicLink() ||
      (state.mode & 0o777n) !== 0o700n ||
      process.getuid === undefined ||
      state.uid !== BigInt(process.getuid()) ||
      inside === "" ||
      (!inside.startsWith("..") && !isAbsolute(inside))
    ) {
      throw new Error("invalid root");
    }
    for (let cursor = physical; ; cursor = dirname(cursor)) {
      if (lstatSync(join(cursor, ".git"), { throwIfNoEntry: false }) !== undefined) {
        throw new Error("checkout root");
      }
      const next = dirname(cursor);
      if (next === cursor) break;
    }
    return { device: state.dev, inode: state.ino };
  } catch {
    throw preflightError("fresh D1 attempt custody root is absent, aliased, or not private");
  }
}

function readRecord(
  path: string,
  stage: Stage,
  binding: FreshD1AttemptBinding,
): AttemptRecord | null {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (stat === undefined) return null;
  let descriptor = -1;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = fstatSync(descriptor);
    if (
      !info.isFile() ||
      info.nlink !== 1 ||
      info.uid !== process.getuid?.() ||
      (info.mode & 0o777) !== 0o600 ||
      info.size < 1 ||
      info.size > MAX_RECORD_BYTES
    ) {
      throw new Error("unsafe receipt");
    }
    const value: unknown = JSON.parse(readFileSync(descriptor, "utf8"));
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error("malformed receipt");
    }
    const record = value as Record<string, unknown>;
    const expected = [
      "binding",
      "digest",
      "kind",
      "stage",
      ...(stage === "intent" ? [] : ["databaseId", "previousDigest"]),
    ].sort();
    if (
      JSON.stringify(Object.keys(record).sort()) !== JSON.stringify(expected) ||
      record.kind !== "takoserver.production-d1-fresh-attempt@v1" ||
      record.stage !== stage ||
      JSON.stringify(record.binding) !== JSON.stringify(binding) ||
      typeof record.digest !== "string" ||
      !SHA256.test(record.digest)
    ) {
      throw new Error("receipt binding mismatch");
    }
    const { digest: recordedDigest, ...body } = record;
    if (recordedDigest !== digest(JSON.stringify(body))) throw new Error("receipt digest mismatch");
    return record as unknown as AttemptRecord;
  } catch {
    throw mutationError("fresh D1 attempt custody is malformed; prior dispatch is unknown");
  } finally {
    if (descriptor >= 0) closeSync(descriptor);
  }
}
