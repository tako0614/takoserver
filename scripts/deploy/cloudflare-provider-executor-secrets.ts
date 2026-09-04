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

export const CLOUDFLARE_PROVIDER_EXECUTOR_SECRET_NAMES = [
  "CLOUDFLARE_API_TOKEN",
  "TAKOSERVER_RUNTIME_INPUT_SEAL_KEYRING",
] as const;

export type CloudflareProviderExecutorSecretName =
  (typeof CLOUDFLARE_PROVIDER_EXECUTOR_SECRET_NAMES)[number];

export type CloudflareProviderExecutorSecrets = Readonly<
  Record<CloudflareProviderExecutorSecretName, string>
>;

const MAX_SECRET_FILE_BYTES = 32 * 1024;
const MAX_SECRET_VALUE_BYTES = 16 * 1024;
const MATERIALIZED_NAME = "cloudflare-provider-executor-secrets.json";

/** Read one stable, link-free, owner-only executor credential file. */
export function readCloudflareProviderExecutorSecrets(sourcePath: string): {
  readonly sourcePath: string;
  readonly values: CloudflareProviderExecutorSecrets;
  readonly bytes: Buffer;
} {
  const path = exactPrivatePath(sourcePath);
  let descriptor: number | null = null;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = fstatSync(descriptor, { bigint: true });
    const link = lstatSync(path, { bigint: true });
    assertPrivateSecretFile(before, link);
    const bytes = readFileSync(descriptor);
    const after = fstatSync(descriptor, { bigint: true });
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs
    ) {
      throw preflightError("Cloudflare provider executor secret input changed while it was read");
    }
    return { sourcePath: path, values: parseExactSecrets(bytes), bytes };
  } catch (error) {
    if (error instanceof Error && error.name === "DeployError") throw error;
    throw preflightError(
      "Cloudflare provider executor secret input is unreadable or unsafe",
      error instanceof Error ? error.name : typeof error,
    );
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}

/**
 * Copies the exact credential bytes into the sealed release directory.
 * Wrangler opens only this copy, closing validation-to-publication replacement.
 */
export function materializeCloudflareProviderExecutorSecrets(input: {
  readonly sourcePath: string;
  readonly releaseRoot: string;
}): {
  readonly path: string;
  readonly names: readonly CloudflareProviderExecutorSecretName[];
  readonly values: CloudflareProviderExecutorSecrets;
} {
  const source = readCloudflareProviderExecutorSecrets(input.sourcePath);
  const releaseRoot = exactReleaseRoot(input.releaseRoot);
  const path = join(releaseRoot, MATERIALIZED_NAME);
  let materialized = false;
  try {
    const output = openSync(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      writeFileSync(output, source.bytes);
      fsyncSync(output);
      const held = fstatSync(output, { bigint: true });
      if (!held.isFile() || held.nlink !== 1n || Number(held.mode & 0o777n) !== 0o600) {
        throw preflightError("sealed Cloudflare provider executor secret copy is not private");
      }
    } finally {
      closeSync(output);
    }
    materialized = true;
    return {
      path,
      names: CLOUDFLARE_PROVIDER_EXECUTOR_SECRET_NAMES,
      values: source.values,
    };
  } catch (error) {
    if (!materialized) {
      try {
        rmSync(path, { force: true });
      } catch {
        // Preserve the validation/publication error as the primary failure.
      }
    }
    if (error instanceof Error && error.name === "DeployError") throw error;
    throw preflightError(
      "Cloudflare provider executor secret copy could not be sealed",
      error instanceof Error ? error.name : typeof error,
    );
  }
}

export function cloudflareProviderExecutorSecretsFileName(): string {
  return MATERIALIZED_NAME;
}

function exactPrivatePath(value: string): string {
  if (!isAbsolute(value)) {
    throw preflightError("Cloudflare provider executor secret path must be absolute");
  }
  const resolved = resolve(value);
  let canonical: string;
  try {
    canonical = realpathSync(resolved);
  } catch (error) {
    throw preflightError(
      "Cloudflare provider executor secret path is unavailable",
      error instanceof Error ? error.name : "",
    );
  }
  if (canonical !== resolved) {
    throw preflightError(
      "Cloudflare provider executor secret path must be link-free and canonical",
    );
  }
  const fromRepository = relative(realpathSync(REPOSITORY), canonical);
  if (fromRepository === "" || (!fromRepository.startsWith("..") && !isAbsolute(fromRepository))) {
    throw preflightError("Cloudflare provider executor secrets must stay outside the repository");
  }
  return canonical;
}

function exactReleaseRoot(value: string): string {
  if (!isAbsolute(value)) {
    throw preflightError("Cloudflare provider executor release root must be absolute");
  }
  const resolved = resolve(value);
  const held = statSync(resolved, { bigint: true });
  if (
    !held.isDirectory() ||
    held.uid !== BigInt(process.getuid?.() ?? -1) ||
    Number(held.mode & 0o777n) !== 0o700
  ) {
    throw preflightError(
      "Cloudflare provider executor release root must be an owned mode-0700 directory",
    );
  }
  const canonical = realpathSync(resolved);
  if (canonical !== resolved || realpathSync(dirname(resolved)) !== dirname(resolved)) {
    throw preflightError(
      "Cloudflare provider executor release root must be link-free and canonical",
    );
  }
  const fromRepository = relative(realpathSync(REPOSITORY), canonical);
  if (fromRepository === "" || (!fromRepository.startsWith("..") && !isAbsolute(fromRepository))) {
    throw preflightError(
      "Cloudflare provider executor release root must stay outside the repository",
    );
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
      "Cloudflare provider executor secret input must be an owned, single-link, mode-0600 regular file of bounded size",
    );
  }
}

function parseExactSecrets(raw: Buffer): CloudflareProviderExecutorSecrets {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
  } catch {
    throw preflightError("Cloudflare provider executor secret input must be canonical UTF-8 JSON");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw preflightError("Cloudflare provider executor secret input must be one JSON object");
  }
  const record = value as Readonly<Record<string, unknown>>;
  const keys = Object.keys(record).sort();
  const expected = [...CLOUDFLARE_PROVIDER_EXECUTOR_SECRET_NAMES].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw preflightError("Cloudflare provider executor secret names are not the exact closed set");
  }
  const result = Object.fromEntries(
    CLOUDFLARE_PROVIDER_EXECUTOR_SECRET_NAMES.map((name) => {
      const secret = record[name];
      if (
        typeof secret !== "string" ||
        secret.length === 0 ||
        new TextEncoder().encode(secret).byteLength > MAX_SECRET_VALUE_BYTES ||
        secret.trim() !== secret ||
        hasControlCharacter(secret)
      ) {
        throw preflightError(`Cloudflare provider executor secret ${name} is invalid`);
      }
      return [name, secret];
    }),
  ) as Record<CloudflareProviderExecutorSecretName, string>;
  if (!raw.equals(canonicalBytes(result))) {
    throw preflightError("Cloudflare provider executor secret input must use canonical JSON bytes");
  }
  return result;
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function canonicalBytes(secrets: CloudflareProviderExecutorSecrets): Buffer {
  return Buffer.from(`${JSON.stringify(secrets, null, 2)}\n`, "utf8");
}
