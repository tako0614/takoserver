import {
  type BigIntStats,
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { preflightError } from "./errors.ts";
import { REPOSITORY } from "./process.ts";

export const MANAGED_OBJECT_RECEIPT_SECRET_NAMES = [
  "TAKOSERVER_MANAGED_OBJECT_ACCESS_KEY_ID",
  "TAKOSERVER_MANAGED_OBJECT_SECRET_ACCESS_KEY",
  "TAKOSERVER_MANAGED_OBJECT_PROOF_SECRET",
] as const;

export type ManagedObjectReceiptSecretName = (typeof MANAGED_OBJECT_RECEIPT_SECRET_NAMES)[number];

const MAX_SECRET_FILE_BYTES = 16 * 1024;
const MAX_SECRET_VALUE_BYTES = 4 * 1024;

/**
 * Copies one exact operator-owned JSON secret set into the caller's sealed
 * release directory. Wrangler receives only this stable copy, closing the gap
 * between validation and its later open(2).
 */
export function materializeManagedObjectReceiptSecrets(input: {
  readonly sourcePath: string;
  readonly releaseRoot: string;
}): { readonly path: string; readonly names: readonly ManagedObjectReceiptSecretName[] } {
  const sourcePath = exactPrivatePath(input.sourcePath, "managed ObjectBucket receipt secrets");
  const releaseRoot = exactReleaseRoot(input.releaseRoot);
  let descriptor: number | null = null;
  let outputPath: string | null = null;
  let materialized = false;
  try {
    descriptor = openSync(sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = fstatSync(descriptor, { bigint: true });
    const link = lstatSync(sourcePath, { bigint: true });
    assertPrivateSecretFile(before, link);
    const raw = readFileSync(descriptor);
    const after = fstatSync(descriptor, { bigint: true });
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs
    ) {
      throw preflightError("managed ObjectBucket receipt secret input changed while it was read");
    }
    const secrets = parseExactSecrets(raw);
    outputPath = join(releaseRoot, "managed-object-receipt-secrets.json");
    const output = openSync(
      outputPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      writeFileSync(output, canonicalBytes(secrets));
      fsyncSync(output);
      const held = fstatSync(output, { bigint: true });
      if (!held.isFile() || held.nlink !== 1n || Number(held.mode & 0o777n) !== 0o600) {
        throw preflightError("sealed managed ObjectBucket receipt secret copy is not private");
      }
    } finally {
      closeSync(output);
    }
    materialized = true;
    return { path: outputPath, names: MANAGED_OBJECT_RECEIPT_SECRET_NAMES };
  } catch (error) {
    if (outputPath !== null && !materialized) {
      try {
        rmSync(outputPath, { force: true });
      } catch {
        // Preserve the validation/publication error as the primary failure.
      }
    }
    if (error instanceof Error && error.name === "DeployError") throw error;
    throw preflightError(
      "managed ObjectBucket receipt secret input is unreadable or unsafe",
      error instanceof Error ? error.name : typeof error,
    );
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}

function exactPrivatePath(value: string, label: string): string {
  if (!isAbsolute(value)) throw preflightError(`${label} path must be absolute`);
  const resolved = resolve(value);
  let canonical: string;
  try {
    canonical = realpathSync(resolved);
  } catch (error) {
    throw preflightError(`${label} path is unavailable`, error instanceof Error ? error.name : "");
  }
  if (canonical !== resolved) throw preflightError(`${label} path must be link-free and canonical`);
  const fromRepository = relative(realpathSync(REPOSITORY), canonical);
  if (fromRepository === "" || (!fromRepository.startsWith("..") && !isAbsolute(fromRepository))) {
    throw preflightError(`${label} must stay outside the repository`);
  }
  return canonical;
}

function exactReleaseRoot(value: string): string {
  if (!isAbsolute(value)) throw preflightError("receipt authority release root must be absolute");
  const resolved = resolve(value);
  const held = statSync(resolved, { bigint: true });
  if (
    !held.isDirectory() ||
    held.uid !== BigInt(process.getuid?.() ?? -1) ||
    Number(held.mode & 0o777n) !== 0o700
  ) {
    throw preflightError("receipt authority release root must be an owned mode-0700 directory");
  }
  const canonical = realpathSync(resolved);
  if (canonical !== resolved || realpathSync(dirname(resolved)) !== dirname(resolved)) {
    throw preflightError("receipt authority release root must be link-free and canonical");
  }
  const fromRepository = relative(realpathSync(REPOSITORY), canonical);
  if (fromRepository === "" || (!fromRepository.startsWith("..") && !isAbsolute(fromRepository))) {
    throw preflightError("receipt authority release root must stay outside the repository");
  }
  return canonical;
}

function assertPrivateSecretFile(file: BigIntStats, link: BigIntStats): void {
  const uid = BigInt(process.getuid?.() ?? -1);
  if (
    !file.isFile() ||
    !link.isFile() ||
    file.dev !== link.dev ||
    file.ino !== link.ino ||
    file.uid !== uid ||
    link.uid !== uid ||
    file.nlink !== 1n ||
    link.nlink !== 1n ||
    Number(file.mode & 0o777n) !== 0o600 ||
    Number(link.mode & 0o777n) !== 0o600 ||
    file.size < 3n ||
    file.size > BigInt(MAX_SECRET_FILE_BYTES)
  ) {
    throw preflightError(
      "managed ObjectBucket receipt secret input must be an owned, single-link, mode-0600 regular file of bounded size",
    );
  }
}

function parseExactSecrets(raw: Buffer): Readonly<Record<ManagedObjectReceiptSecretName, string>> {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
  } catch {
    throw preflightError("managed ObjectBucket receipt secret input must be canonical UTF-8 JSON");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw preflightError("managed ObjectBucket receipt secret input must be one JSON object");
  }
  const record = value as Readonly<Record<string, unknown>>;
  const keys = Object.keys(record).sort();
  const expected = [...MANAGED_OBJECT_RECEIPT_SECRET_NAMES].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw preflightError("managed ObjectBucket receipt secret names are not the exact closed set");
  }
  const result = Object.fromEntries(
    MANAGED_OBJECT_RECEIPT_SECRET_NAMES.map((name) => {
      const secret = record[name];
      if (
        typeof secret !== "string" ||
        secret.length === 0 ||
        new TextEncoder().encode(secret).byteLength > MAX_SECRET_VALUE_BYTES ||
        secret.trim() !== secret ||
        containsControlCharacter(secret)
      ) {
        throw preflightError(`managed ObjectBucket receipt secret ${name} is invalid`);
      }
      return [name, secret];
    }),
  ) as Record<ManagedObjectReceiptSecretName, string>;
  const canonical = canonicalBytes(result);
  if (!raw.equals(canonical)) {
    throw preflightError(
      "managed ObjectBucket receipt secret input must use the canonical closed JSON encoding",
    );
  }
  return result;
}

function containsControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function canonicalBytes(secrets: Readonly<Record<ManagedObjectReceiptSecretName, string>>): Buffer {
  return Buffer.from(`${JSON.stringify(secrets, null, 2)}\n`, "utf8");
}
