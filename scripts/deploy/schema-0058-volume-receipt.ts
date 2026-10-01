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

/** Separate from the fixed synthetic attempt: neither receipt grants protected apply authority. */
export interface VolumeReceipt {
  readonly kind: "takoserver.d1-0058-selected-reference-volume@v1";
  readonly state: "prepared" | "dispatched" | "qualified";
  readonly binding: {
    readonly referenceTargetD1: {
      readonly accountId: string;
      readonly databaseId: string;
      readonly databaseName: string;
    };
    readonly isolatedTargetD1: {
      readonly accountId: string;
      readonly databaseId: string;
      readonly databaseName: string;
    };
    readonly commit: string;
    readonly remoteRef: string;
    readonly prefixDigest: string;
    readonly referenceShapeDigest: string;
    readonly isolatedBeforeShapeDigest: string;
    readonly isolatedTriggerDigest: string;
    readonly importDigest: string;
    readonly importBytes: number;
    readonly fixtureSqlDigest: string;
    readonly queryRollbackProbeDigest: string;
    readonly importRollbackProbeDigest: string;
    readonly referenceDigest: string;
    readonly referenceCounts: Readonly<Record<string, number>>;
    readonly referenceBytes: number;
    readonly referenceMaxBlobBytes: number;
    readonly fixtureDigest: string;
    readonly fixtureCounts: Readonly<Record<string, number>>;
    readonly fixtureBytes: number;
    readonly fixtureMaxBlobBytes: number;
  };
  readonly preparedDigest?: string;
  readonly dispatchedDigest?: string;
  readonly elapsedMs?: number;
  readonly timingSource?: "wrangler-remote-command-wall-clock" | "injected-runner-local-test";
  readonly postShapeDigest?: string;
  readonly providerAcknowledgement?: "wrangler-command-ack-observed" | "injected-runner-simulated";
  readonly rollbackProbes?: "both-failed-and-exact-0057-restored";
  readonly observedAt?: string;
  readonly expiresAt?: string;
  readonly qualification?: "selected-rehearsal-reference-only" | "injected-runner-local-test-only";
  readonly digest: string;
}

function pathFor(custodyPath: string, state: VolumeReceipt["state"]): string {
  return `${custodyPath}.0058-volume-${state}.json`;
}

function hash(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

const MAX_RECEIPT_BYTES = 16 * 1024;
const TABLES = [
  "cloudflare_managed_worker_receipts",
  "cloudflare_managed_worker_version_execution_material",
  "cloudflare_managed_worker_version_execution_secrets",
  "cloudflare_managed_worker_version_execution_provider_proofs",
] as const;

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function keys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
}

function digest(value: unknown): value is string {
  return typeof value === "string" && /^sha256:[0-9a-f]{64}$/u.test(value);
}

function target(value: unknown): boolean {
  return (
    object(value) &&
    keys(value, ["accountId", "databaseId", "databaseName"]) &&
    typeof value.accountId === "string" &&
    /^[0-9a-f]{32}$/u.test(value.accountId) &&
    typeof value.databaseId === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(value.databaseId) &&
    typeof value.databaseName === "string" &&
    /^[a-z0-9][a-z0-9_-]{2,62}$/u.test(value.databaseName)
  );
}

function counts(value: unknown): boolean {
  return (
    object(value) &&
    keys(value, TABLES) &&
    Object.values(value).every((n) => Number.isSafeInteger(n) && Number(n) >= 0)
  );
}

function binding(value: unknown): value is VolumeReceipt["binding"] {
  if (
    !object(value) ||
    !keys(value, [
      "referenceTargetD1",
      "isolatedTargetD1",
      "commit",
      "remoteRef",
      "prefixDigest",
      "referenceShapeDigest",
      "isolatedBeforeShapeDigest",
      "isolatedTriggerDigest",
      "importDigest",
      "importBytes",
      "fixtureSqlDigest",
      "queryRollbackProbeDigest",
      "importRollbackProbeDigest",
      "referenceDigest",
      "referenceCounts",
      "referenceBytes",
      "referenceMaxBlobBytes",
      "fixtureDigest",
      "fixtureCounts",
      "fixtureBytes",
      "fixtureMaxBlobBytes",
    ])
  )
    return false;
  return (
    target(value.referenceTargetD1) &&
    target(value.isolatedTargetD1) &&
    typeof value.commit === "string" &&
    /^[0-9a-f]{40}$/u.test(value.commit) &&
    typeof value.remoteRef === "string" &&
    value.remoteRef.length > 0 &&
    value.remoteRef.length <= 256 &&
    [
      "prefixDigest",
      "referenceShapeDigest",
      "isolatedBeforeShapeDigest",
      "isolatedTriggerDigest",
      "importDigest",
      "fixtureSqlDigest",
      "queryRollbackProbeDigest",
      "importRollbackProbeDigest",
      "referenceDigest",
      "fixtureDigest",
    ].every((name) => digest(value[name])) &&
    [
      "importBytes",
      "referenceBytes",
      "referenceMaxBlobBytes",
      "fixtureBytes",
      "fixtureMaxBlobBytes",
    ].every((name) => Number.isSafeInteger(value[name]) && Number(value[name]) >= 0) &&
    counts(value.referenceCounts) &&
    counts(value.fixtureCounts)
  );
}

function validReceipt(value: Record<string, unknown>, state: VolumeReceipt["state"]): boolean {
  const common = ["kind", "state", "binding", "digest"];
  const fields =
    state === "prepared"
      ? common
      : state === "dispatched"
        ? [...common, "preparedDigest"]
        : [
            ...common,
            "dispatchedDigest",
            "elapsedMs",
            "timingSource",
            "postShapeDigest",
            "providerAcknowledgement",
            "rollbackProbes",
            "observedAt",
            "expiresAt",
            "qualification",
          ];
  if (
    !keys(value, fields) ||
    value.kind !== "takoserver.d1-0058-selected-reference-volume@v1" ||
    value.state !== state ||
    !digest(value.digest) ||
    !binding(value.binding)
  )
    return false;
  if (state === "dispatched") return digest(value.preparedDigest);
  if (state !== "qualified") return true;
  const injected = value.timingSource === "injected-runner-local-test";
  return (
    digest(value.dispatchedDigest) &&
    digest(value.postShapeDigest) &&
    Number.isSafeInteger(value.elapsedMs) &&
    Number(value.elapsedMs) >= 0 &&
    (injected || value.timingSource === "wrangler-remote-command-wall-clock") &&
    value.providerAcknowledgement ===
      (injected ? "injected-runner-simulated" : "wrangler-command-ack-observed") &&
    value.qualification ===
      (injected ? "injected-runner-local-test-only" : "selected-rehearsal-reference-only") &&
    value.rollbackProbes === "both-failed-and-exact-0057-restored" &&
    typeof value.observedAt === "string" &&
    typeof value.expiresAt === "string" &&
    Number.isFinite(Date.parse(value.observedAt)) &&
    Number.isFinite(Date.parse(value.expiresAt)) &&
    Date.parse(value.expiresAt) > Date.parse(value.observedAt)
  );
}

function sameBinding(left: VolumeReceipt["binding"], right: VolumeReceipt["binding"]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function assertReceiptChain(custodyPath: string): {
  readonly prepared: VolumeReceipt | null;
  readonly dispatched: VolumeReceipt | null;
  readonly qualified: VolumeReceipt | null;
} {
  const prepared = read0058VolumeReceipt(custodyPath, "prepared");
  const dispatched = read0058VolumeReceipt(custodyPath, "dispatched");
  const qualified = read0058VolumeReceipt(custodyPath, "qualified");
  if (
    (dispatched !== null &&
      (prepared === null ||
        dispatched.preparedDigest !== prepared.digest ||
        !sameBinding(dispatched.binding, prepared.binding))) ||
    (qualified !== null &&
      (dispatched === null ||
        qualified.dispatchedDigest !== dispatched.digest ||
        !sameBinding(qualified.binding, dispatched.binding)))
  )
    throw preflightError("0058 volume receipt custody chain is missing or changed");
  return { prepared, dispatched, qualified };
}

export const read0058VolumeChain = assertReceiptChain;

export function persist0058VolumeReceipt(
  custodyPath: string,
  receipt: Omit<VolumeReceipt, "digest">,
): VolumeReceipt {
  if (receipt.state !== "prepared") {
    const chain = assertReceiptChain(custodyPath);
    if (
      receipt.state === "dispatched"
        ? chain.prepared === null ||
          chain.dispatched !== null ||
          receipt.preparedDigest !== chain.prepared.digest ||
          !sameBinding(receipt.binding, chain.prepared.binding)
        : chain.dispatched === null ||
          chain.qualified !== null ||
          receipt.dispatchedDigest !== chain.dispatched.digest ||
          !sameBinding(receipt.binding, chain.dispatched.binding)
    )
      throw preflightError("0058 volume receipt parent changed before persistence");
  }
  let directory: number;
  try {
    directory = openSync(
      dirname(custodyPath),
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
  } catch {
    throw preflightError("0058 volume receipt custody directory is unavailable");
  }
  try {
    const info = fstatSync(directory);
    if (!info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o700)
      throw preflightError("0058 volume receipt custody directory must be owner-owned 0700");
    const complete: VolumeReceipt = { ...receipt, digest: hash(receipt) };
    if (!validReceipt(complete as unknown as Record<string, unknown>, receipt.state))
      throw preflightError("0058 volume receipt payload is invalid");
    const bytes = Buffer.from(`${JSON.stringify(complete)}\n`, "utf8");
    if (bytes.length > MAX_RECEIPT_BYTES)
      throw preflightError("0058 volume receipt exceeds its bound");
    let file: number;
    try {
      file = openSync(
        pathFor(custodyPath, receipt.state),
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
    } catch {
      throw preflightError("0058 volume receipt already exists or could not be persisted");
    }
    try {
      fchmodSync(file, 0o600);
      const created = fstatSync(file);
      if (
        !created.isFile() ||
        created.uid !== process.getuid?.() ||
        created.nlink !== 1 ||
        (created.mode & 0o777) !== 0o600
      )
        throw preflightError("0058 volume receipt custody is invalid after creation");
      let offset = 0;
      while (offset < bytes.length) {
        const count = writeSync(file, bytes, offset, bytes.length - offset);
        if (count <= 0) throw preflightError("0058 volume receipt could not be persisted");
        offset += count;
      }
      fsyncSync(file);
      fsyncSync(directory);
    } finally {
      closeSync(file);
    }
    return complete;
  } finally {
    closeSync(directory);
  }
}

export function read0058VolumeReceipt(
  custodyPath: string,
  state: VolumeReceipt["state"],
): VolumeReceipt | null {
  let file: number;
  try {
    file = openSync(
      pathFor(custodyPath, state),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw preflightError("0058 volume receipt could not be opened safely");
  }
  try {
    const info = fstatSync(file);
    if (
      !info.isFile() ||
      info.uid !== process.getuid?.() ||
      info.nlink !== 1 ||
      (info.mode & 0o777) !== 0o600 ||
      info.size > MAX_RECEIPT_BYTES
    )
      throw preflightError("0058 volume receipt custody is invalid");
    const bytes = Buffer.alloc(MAX_RECEIPT_BYTES + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const read = readSync(file, bytes, offset, bytes.length - offset, null);
      if (read === 0) break;
      offset += read;
    }
    if (offset > MAX_RECEIPT_BYTES)
      throw preflightError("0058 volume receipt exceeds the bounded read limit");
    const value: unknown = JSON.parse(bytes.subarray(0, offset).toString("utf8"));
    if (typeof value !== "object" || value === null || Array.isArray(value))
      throw preflightError("0058 volume receipt is malformed");
    const record = value as Record<string, unknown>;
    const { digest, ...payload } = record;
    if (!validReceipt(record, state) || digest !== hash(payload))
      throw preflightError("0058 volume receipt is malformed or changed");
    return record as unknown as VolumeReceipt;
  } catch (error) {
    if (error instanceof SyntaxError) throw preflightError("0058 volume receipt is invalid JSON");
    throw error;
  } finally {
    closeSync(file);
  }
}
