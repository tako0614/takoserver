import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  openSync,
  readSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";
import { preflightError } from "./errors.ts";

export interface ApplyReceiptBinding {
  readonly environment: "rehearsal";
  readonly target: {
    readonly accountId: string;
    readonly databaseId: string;
    readonly databaseName: string;
  };
  readonly source: {
    readonly commit: string;
    readonly prefix: readonly { readonly name: string; readonly digest: string }[];
    readonly importDigest: string;
    readonly importBytes: number;
  };
  readonly before: {
    readonly lineage: readonly string[];
    readonly shapeDigest: string;
    readonly triggerDigest: string;
    readonly snapshot: unknown;
  };
}

export interface ApplyReceipt extends ApplyReceiptBinding {
  readonly kind: "takoserver.d1-0058-isolated-apply-attempt@v1";
  readonly state: "prepared" | "dispatched";
  readonly preparedDigest?: string;
  readonly digest: string;
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function payload(receipt: Omit<ApplyReceipt, "digest">): string {
  return JSON.stringify(receipt);
}

const MAX_RECEIPT_BYTES = 128 * 1024;

function receiptPath(custodyPath: string, state: "prepared" | "dispatched"): string {
  return `${custodyPath}.0058-${state}.json`;
}

function openPrivateDirectory(custodyPath: string): number {
  let descriptor: number;
  try {
    descriptor = openSync(
      dirname(custodyPath),
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
  } catch {
    throw preflightError("0058 receipt custody directory is unavailable");
  }
  try {
    const directory = fstatSync(descriptor);
    if (
      !directory.isDirectory() ||
      directory.uid !== process.getuid?.() ||
      (directory.mode & 0o777) !== 0o700
    ) {
      throw preflightError("0058 receipt custody directory must be owner-owned 0700");
    }
    return descriptor;
  } catch (error) {
    closeSync(descriptor);
    throw error;
  }
}

function writeReceipt(
  path: string,
  receipt: Omit<ApplyReceipt, "digest">,
  directoryDescriptor: number,
): ApplyReceipt {
  const digest = sha256(payload(receipt));
  const complete: ApplyReceipt = { ...receipt, digest };
  const bytes = Buffer.from(`${JSON.stringify(complete)}\n`, "utf8");
  let descriptor: number;
  try {
    descriptor = openSync(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
  } catch {
    throw preflightError("0058 attempt receipt already exists or could not be persisted");
  }
  try {
    fchmodSync(descriptor, 0o600);
    const info = fstatSync(descriptor);
    if (
      !info.isFile() ||
      info.uid !== process.getuid?.() ||
      info.nlink !== 1 ||
      (info.mode & 0o777) !== 0o600
    ) {
      throw preflightError("0058 attempt receipt custody is invalid after creation");
    }
    let offset = 0;
    while (offset < bytes.length) {
      const written = writeSync(descriptor, bytes, offset, bytes.length - offset);
      if (written <= 0) throw preflightError("0058 attempt receipt could not be persisted");
      offset += written;
    }
    fsyncSync(descriptor);
    fsyncSync(directoryDescriptor);
  } catch (error) {
    closeSync(descriptor);
    throw error;
  }
  closeSync(descriptor);
  return complete;
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
}

function validSnapshot(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const snapshot = value as Record<string, unknown>;
  if (
    !hasExactKeys(snapshot, [
      "counts",
      "states",
      "digest",
      "blobBytes",
      "exactSyntheticBlobs",
      "foreignKeyViolations",
      "foreignKeysEnabled",
    ]) ||
    typeof snapshot.counts !== "object" ||
    snapshot.counts === null ||
    Array.isArray(snapshot.counts) ||
    typeof snapshot.states !== "object" ||
    snapshot.states === null ||
    Array.isArray(snapshot.states)
  ) {
    return false;
  }
  const counts = snapshot.counts as Record<string, unknown>;
  const states = snapshot.states as Record<string, unknown>;
  return (
    hasExactKeys(counts, [
      "cloudflare_managed_worker_receipts",
      "cloudflare_managed_worker_version_execution_material",
      "cloudflare_managed_worker_version_execution_secrets",
      "cloudflare_managed_worker_version_execution_provider_proofs",
    ]) &&
    Object.values(counts).every((count) => Number.isSafeInteger(count) && Number(count) >= 0) &&
    hasExactKeys(states, ["pending", "committed", "deleting", "deleted"]) &&
    Object.values(states).every((count) => Number.isSafeInteger(count) && Number(count) >= 0) &&
    typeof snapshot.digest === "string" &&
    /^sha256:[0-9a-f]{64}$/u.test(snapshot.digest) &&
    Number.isSafeInteger(snapshot.blobBytes) &&
    Number(snapshot.blobBytes) >= 0 &&
    typeof snapshot.exactSyntheticBlobs === "boolean" &&
    Number.isSafeInteger(snapshot.foreignKeyViolations) &&
    Number(snapshot.foreignKeyViolations) >= 0 &&
    typeof snapshot.foreignKeysEnabled === "boolean"
  );
}

function validReceiptShape(
  value: Record<string, unknown>,
): value is Record<string, unknown> & ApplyReceipt {
  const state = value.state;
  const expectedKeys = [
    "kind",
    "state",
    ...(state === "dispatched" ? ["preparedDigest"] : []),
    "environment",
    "target",
    "source",
    "before",
    "digest",
  ];
  if (
    !hasExactKeys(value, expectedKeys) ||
    value.kind !== "takoserver.d1-0058-isolated-apply-attempt@v1" ||
    (state !== "prepared" && state !== "dispatched") ||
    value.environment !== "rehearsal" ||
    typeof value.target !== "object" ||
    value.target === null ||
    Array.isArray(value.target) ||
    typeof value.source !== "object" ||
    value.source === null ||
    Array.isArray(value.source) ||
    typeof value.before !== "object" ||
    value.before === null ||
    Array.isArray(value.before)
  ) {
    return false;
  }
  const target = value.target as Record<string, unknown>;
  const source = value.source as Record<string, unknown>;
  const before = value.before as Record<string, unknown>;
  if (
    !hasExactKeys(target, ["accountId", "databaseId", "databaseName"]) ||
    typeof target.accountId !== "string" ||
    !/^[0-9a-f]{32}$/u.test(target.accountId) ||
    typeof target.databaseId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(target.databaseId) ||
    typeof target.databaseName !== "string" ||
    !/^[a-z0-9][a-z0-9_-]{2,62}$/u.test(target.databaseName) ||
    !hasExactKeys(source, ["commit", "prefix", "importDigest", "importBytes"]) ||
    typeof source.commit !== "string" ||
    !/^[0-9a-f]{40}$/u.test(source.commit) ||
    !Array.isArray(source.prefix) ||
    source.prefix.length !== 58 ||
    !source.prefix.every((entry) => {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return false;
      const file = entry as Record<string, unknown>;
      return (
        hasExactKeys(file, ["name", "digest"]) &&
        typeof file.name === "string" &&
        /^[0-9]{4}_[a-z0-9_]+\.sql$/u.test(file.name) &&
        typeof file.digest === "string" &&
        /^sha256:[0-9a-f]{64}$/u.test(file.digest)
      );
    }) ||
    typeof source.importDigest !== "string" ||
    !/^sha256:[0-9a-f]{64}$/u.test(source.importDigest) ||
    !Number.isSafeInteger(source.importBytes) ||
    Number(source.importBytes) <= 0 ||
    Number(source.importBytes) > 16 * 1024 * 1024 ||
    !hasExactKeys(before, ["lineage", "shapeDigest", "triggerDigest", "snapshot"]) ||
    !Array.isArray(before.lineage) ||
    before.lineage.length !== 57 ||
    !before.lineage.every((name) => typeof name === "string" && name.length <= 128) ||
    typeof before.shapeDigest !== "string" ||
    !/^sha256:[0-9a-f]{64}$/u.test(before.shapeDigest) ||
    typeof before.triggerDigest !== "string" ||
    !/^sha256:[0-9a-f]{64}$/u.test(before.triggerDigest) ||
    !validSnapshot(before.snapshot) ||
    typeof value.digest !== "string" ||
    !/^sha256:[0-9a-f]{64}$/u.test(value.digest) ||
    (state === "dispatched" &&
      (typeof value.preparedDigest !== "string" ||
        !/^sha256:[0-9a-f]{64}$/u.test(value.preparedDigest)))
  ) {
    return false;
  }
  return true;
}

export function persistPrepared0058Receipt(
  custodyPath: string,
  binding: ApplyReceiptBinding,
): ApplyReceipt {
  const directoryDescriptor = openPrivateDirectory(custodyPath);
  try {
    return writeReceipt(
      receiptPath(custodyPath, "prepared"),
      {
        kind: "takoserver.d1-0058-isolated-apply-attempt@v1",
        state: "prepared",
        ...binding,
      },
      directoryDescriptor,
    );
  } finally {
    closeSync(directoryDescriptor);
  }
}

export function persistDispatched0058Receipt(
  custodyPath: string,
  binding: ApplyReceiptBinding,
  prepared: ApplyReceipt,
): ApplyReceipt {
  const directoryDescriptor = openPrivateDirectory(custodyPath);
  try {
    const canonical = read0058Receipt(custodyPath, "prepared");
    if (
      canonical === null ||
      canonical.digest !== prepared.digest ||
      JSON.stringify(canonical) !== JSON.stringify(prepared) ||
      canonical.environment !== binding.environment ||
      JSON.stringify(canonical.target) !== JSON.stringify(binding.target) ||
      JSON.stringify(canonical.source) !== JSON.stringify(binding.source) ||
      JSON.stringify(canonical.before) !== JSON.stringify(binding.before)
    ) {
      throw preflightError("0058 prepared receipt binding changed before dispatch");
    }
    return writeReceipt(
      receiptPath(custodyPath, "dispatched"),
      {
        kind: "takoserver.d1-0058-isolated-apply-attempt@v1",
        state: "dispatched",
        preparedDigest: canonical.digest,
        ...binding,
      },
      directoryDescriptor,
    );
  } finally {
    closeSync(directoryDescriptor);
  }
}

function parseReceipt(path: string): ApplyReceipt | null {
  let descriptor: number;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw preflightError("0058 attempt receipt could not be opened safely");
  }
  let value: unknown;
  try {
    const info = fstatSync(descriptor);
    if (
      !info.isFile() ||
      info.nlink !== 1 ||
      info.uid !== process.getuid?.() ||
      (info.mode & 0o777) !== 0o600 ||
      info.size > MAX_RECEIPT_BYTES
    ) {
      throw preflightError("0058 attempt receipt custody is invalid");
    }
    const bytes = Buffer.alloc(MAX_RECEIPT_BYTES + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const read = readSync(descriptor, bytes, offset, bytes.length - offset, null);
      if (read === 0) break;
      offset += read;
    }
    if (offset > MAX_RECEIPT_BYTES)
      throw preflightError("0058 attempt receipt exceeds the bounded read limit");
    value = JSON.parse(bytes.subarray(0, offset).toString("utf8"));
  } catch (error) {
    closeSync(descriptor);
    if (error instanceof SyntaxError) throw preflightError("0058 attempt receipt is invalid JSON");
    throw error;
  }
  closeSync(descriptor);
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw preflightError("0058 attempt receipt is invalid");
  const recordValue = value as Record<string, unknown>;
  if (!validReceiptShape(recordValue))
    throw preflightError("0058 attempt receipt shape is invalid");
  const record = recordValue;
  const { digest, ...body } = record;
  if (typeof digest !== "string" || sha256(payload(body)) !== digest) {
    throw preflightError("0058 attempt receipt integrity check failed");
  }
  return record;
}

export function read0058Receipt(
  custodyPath: string,
  state: "prepared" | "dispatched",
): ApplyReceipt | null {
  const directoryDescriptor = openPrivateDirectory(custodyPath);
  try {
    const receipt = parseReceipt(receiptPath(custodyPath, state));
    if (receipt !== null && receipt.state !== state)
      throw preflightError("0058 attempt receipt state does not match receipt filename");
    return receipt;
  } finally {
    closeSync(directoryDescriptor);
  }
}

export function read0058DispatchedReceipt(custodyPath: string): ApplyReceipt | null {
  const dispatched = read0058Receipt(custodyPath, "dispatched");
  const prepared = read0058Receipt(custodyPath, "prepared");
  if (dispatched === null) return prepared;
  if (
    prepared === null ||
    dispatched.preparedDigest !== prepared.digest ||
    dispatched.environment !== prepared.environment ||
    JSON.stringify(dispatched.target) !== JSON.stringify(prepared.target) ||
    JSON.stringify(dispatched.source) !== JSON.stringify(prepared.source) ||
    JSON.stringify(dispatched.before) !== JSON.stringify(prepared.before)
  ) {
    throw preflightError("0058 prepared and dispatched receipts disagree");
  }
  return dispatched;
}

export type AttemptReceiptState = ApplyReceipt["state"];
