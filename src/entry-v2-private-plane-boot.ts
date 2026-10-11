import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

const CONFIG_NAME = "TAKOSERVER_V2_WORKER_PRIVATE_PLANES";
/** Raw operator-created key files are bounded; no unbounded secret file reads. */
const KEY_MIN_BYTES = 32;
const KEY_MAX_BYTES = 4_096;
const TARGET_DIRECTORY = {
  sqlite: "v2-sqlite-databases",
  kv: "v2-kv-namespaces",
  objectBucket: "v2-object-buckets",
} as const;

type PlaneName = "sqlite" | "kv" | "objectBucket" | "queue" | "queueProducer";
type PlaneBoot = {
  readonly privatePort: number;
  readonly signingKey: Uint8Array;
};

export interface SelfhostV2PrivatePlaneBoot {
  readonly sqlite?: PlaneBoot & { readonly root: string; readonly stagingRoot: string };
  readonly kv?: PlaneBoot & { readonly root: string };
  readonly objectBucket?: PlaneBoot & { readonly root: string };
  readonly queue?: PlaneBoot;
  readonly queueProducer?: PlaneBoot;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactFields(
  value: unknown,
  name: string,
  fields: readonly string[],
): Record<string, unknown> {
  if (!isRecord(value) || Object.keys(value).length !== fields.length) {
    throw new TypeError(`${CONFIG_NAME}.${name} is incomplete`);
  }
  for (const field of Object.keys(value)) {
    if (!fields.includes(field)) throw new TypeError(`${CONFIG_NAME}.${name} has an unknown field`);
  }
  return value;
}

function checkedPrivateDirectory(path: string, name: string): string {
  if (!isAbsolute(path) || resolve(path) !== path) {
    throw new TypeError(`${name} must be an absolute canonical private directory`);
  }
  const uid = process.getuid?.();
  if (uid === undefined) throw new TypeError(`${name} requires local owner identity`);
  let current = path;
  let leaf = true;
  while (true) {
    let metadata: ReturnType<typeof lstatSync>;
    try {
      metadata = lstatSync(current);
      if (
        !metadata.isDirectory() ||
        metadata.isSymbolicLink() ||
        realpathSync(current) !== current
      ) {
        throw new Error("not a real directory");
      }
    } catch {
      throw new TypeError(`${name} must use real directories: ${current} is not one`);
    }
    const mode = (metadata.mode & 0o7777).toString(8).padStart(4, "0");
    if (leaf) {
      if (metadata.uid !== uid || (metadata.mode & 0o077) !== 0) {
        throw new TypeError(
          `${name} must be owned and private: ${current} has mode ${mode} and owner uid ` +
            `${metadata.uid}, but needs mode 0700 and owner uid ${uid}`,
        );
      }
      leaf = false;
    } else if (
      (metadata.mode & 0o022) !== 0 &&
      !((metadata.mode & 0o1000) !== 0 && metadata.uid === 0)
    ) {
      throw new TypeError(
        `${name} has an unsafe writable ancestor: ${current} has mode ${mode} and owner uid ${metadata.uid}`,
      );
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return path;
}

function readPrivateKey(path: unknown, name: PlaneName): Uint8Array {
  if (typeof path !== "string" || !isAbsolute(path) || resolve(path) !== path) {
    throw new TypeError(`${CONFIG_NAME}.${name}.signingKeyFile must be an absolute file`);
  }
  checkedPrivateDirectory(dirname(path), `${CONFIG_NAME}.${name}.signingKeyFile parent`);
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    throw new TypeError(`${CONFIG_NAME}.${name}.signingKeyFile is unavailable`);
  }
  const bytes = Buffer.alloc(KEY_MAX_BYTES + 1);
  try {
    const before = fstatSync(fd);
    const pathBefore = lstatSync(path);
    const uid = process.getuid?.();
    if (before.size < KEY_MIN_BYTES || before.size > KEY_MAX_BYTES) {
      throw new TypeError(`${CONFIG_NAME}.${name}.signingKeyFile must contain 32 to 4096 bytes`);
    }
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      before.uid !== uid ||
      (before.mode & 0o077) !== 0 ||
      before.dev !== pathBefore.dev ||
      before.ino !== pathBefore.ino ||
      realpathSync(path) !== path
    ) {
      throw new TypeError(`${CONFIG_NAME}.${name}.signingKeyFile is not private`);
    }
    let length = 0;
    while (length < bytes.byteLength) {
      const count = readSync(fd, bytes, length, bytes.byteLength - length, length);
      if (count === 0) break;
      length += count;
    }
    const after = fstatSync(fd);
    const pathAfter = lstatSync(path);
    if (
      length < KEY_MIN_BYTES ||
      length > KEY_MAX_BYTES ||
      before.size !== length ||
      after.size !== length ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      after.dev !== pathAfter.dev ||
      after.ino !== pathAfter.ino
    ) {
      throw new TypeError(`${CONFIG_NAME}.${name}.signingKeyFile changed or has invalid length`);
    }
    return new Uint8Array(bytes.subarray(0, length));
  } catch (error) {
    if (error instanceof TypeError && error.message.startsWith(CONFIG_NAME)) throw error;
    throw new TypeError(`${CONFIG_NAME}.${name}.signingKeyFile could not be verified`);
  } finally {
    bytes.fill(0);
    closeSync(fd);
  }
}

/** No key or private listener is invented by a normal Bun boot. */
export function parseSelfhostV2PrivatePlaneBoot(
  raw: string | undefined,
  options: { readonly dataRoot: string; readonly reservedPorts?: readonly number[] },
): SelfhostV2PrivatePlaneBoot | undefined {
  if (raw === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new TypeError(`${CONFIG_NAME} must be exact JSON`);
  }
  if (!isRecord(parsed) || Object.keys(parsed).length === 0) {
    throw new TypeError(`${CONFIG_NAME} must select at least one private plane`);
  }
  const names = Object.keys(parsed);
  for (const name of names) {
    if (!["sqlite", "kv", "objectBucket", "queue", "queueProducer"].includes(name)) {
      throw new TypeError(`${CONFIG_NAME} has an unknown plane`);
    }
  }
  const dataRoot = checkedPrivateDirectory(
    options.dataRoot,
    "v2 Worker data root (TAKOSERVER_DATA_ROOT)",
  );
  const ports = new Set(options.reservedPorts ?? []);
  const keys: Uint8Array[] = [];
  const readPlane = (name: PlaneName): PlaneBoot | undefined => {
    const value = parsed[name];
    if (value === undefined) return undefined;
    const fields =
      name === "sqlite"
        ? ["privatePort", "signingKeyFile", "stagingRoot"]
        : ["privatePort", "signingKeyFile"];
    const record = exactFields(value, name, fields);
    const port = record.privatePort;
    if (
      typeof port !== "number" ||
      !Number.isSafeInteger(port) ||
      port < 1 ||
      port > 65_535 ||
      ports.has(port)
    ) {
      throw new TypeError(`${CONFIG_NAME}.${name}.privatePort must be a distinct fixed port`);
    }
    ports.add(port);
    const signingKey = readPrivateKey(record.signingKeyFile, name);
    if (
      keys.some(
        (other) =>
          other.byteLength === signingKey.byteLength &&
          signingKey.every((byte, index) => other[index] === byte),
      )
    ) {
      signingKey.fill(0);
      throw new TypeError(`${CONFIG_NAME} requires a distinct signing key per plane`);
    }
    keys.push(signingKey);
    return { privatePort: port, signingKey };
  };
  try {
    const sqlite = readPlane("sqlite");
    const kv = readPlane("kv");
    const objectBucket = readPlane("objectBucket");
    const queue = readPlane("queue");
    const queueProducer = readPlane("queueProducer");
    let stagingRoot: string | undefined;
    if (sqlite) {
      const sqliteRecord = exactFields(parsed.sqlite, "sqlite", [
        "privatePort",
        "signingKeyFile",
        "stagingRoot",
      ]);
      if (typeof sqliteRecord.stagingRoot !== "string") {
        throw new TypeError(`${CONFIG_NAME}.sqlite.stagingRoot is required`);
      }
      stagingRoot = checkedPrivateDirectory(
        sqliteRecord.stagingRoot,
        `${CONFIG_NAME}.sqlite.stagingRoot`,
      );
    }
    return {
      ...(sqlite && stagingRoot
        ? {
            sqlite: { ...sqlite, root: join(dataRoot, TARGET_DIRECTORY.sqlite), stagingRoot },
          }
        : {}),
      ...(kv ? { kv: { ...kv, root: join(dataRoot, TARGET_DIRECTORY.kv) } } : {}),
      ...(objectBucket
        ? { objectBucket: { ...objectBucket, root: join(dataRoot, TARGET_DIRECTORY.objectBucket) } }
        : {}),
      ...(queue ? { queue } : {}),
      ...(queueProducer ? { queueProducer } : {}),
    };
  } catch (error) {
    for (const key of keys) key.fill(0);
    throw error;
  }
}

/** Ensure only dedicated v2 custody roots are opened; no v1 store is reused. */
export function prepareSelfhostV2PrivatePlaneRoots(boot: SelfhostV2PrivatePlaneBoot): void {
  for (const root of [boot.sqlite?.root, boot.kv?.root, boot.objectBucket?.root]) {
    if (!root) continue;
    mkdirSync(root, { recursive: true, mode: 0o700 });
    checkedPrivateDirectory(root, "v2 Worker private custody root");
  }
}
