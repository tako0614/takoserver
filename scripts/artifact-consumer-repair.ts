import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";
import {
  ARTIFACT_CONSUMER_REPAIR_APPLY_FORMAT,
  ARTIFACT_CONSUMER_REPAIR_STATUS_FORMAT,
  ARTIFACT_CONSUMER_RESOLUTION_RECEIPT_FORMAT,
  type ArtifactConsumerRepairStatus,
  type ArtifactConsumerResolutionReceipt,
} from "../src/artifact-consumer-repair.ts";
import { isSha256Digest } from "../src/json.ts";

const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u;
const OWNER_SESSION_MINIMUM_BYTES = 16;
const OWNER_SESSION_MAXIMUM_BYTES = 512;
const OWNER_SESSION_FILE_ERROR =
  "TAKOSERVER_OWNER_SESSION_FILE must name an absolute canonical owned 0600 link-free single-link regular file containing one exact 16-512 byte token";

interface CliIo {
  readonly fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  readonly stdout: (value: string) => void;
  readonly stderr: (value: string) => void;
  readonly token: () => string;
}

/**
 * Operator client for the lifecycle-owned repair route.
 *
 * `status` is read-only. `apply` always reads a fresh status first and sends
 * only the returned plan digest; there are deliberately no flags for an
 * outcome, manifest digest, provider evidence, or a target-specific override.
 *
 *   TAKOSERVER_OWNER_SESSION_FILE=/secure/session \
 *     bun scripts/artifact-consumer-repair.ts status <origin> <organization> <deployment>
 *
 *   TAKOSERVER_OWNER_SESSION_FILE=/secure/session \
 *     bun scripts/artifact-consumer-repair.ts apply <origin> <organization> <deployment> <idempotency-key>
 */
export async function runArtifactConsumerRepairCli(
  argv: readonly string[],
  io: CliIo = defaultIo(),
): Promise<number> {
  const [command, rawOrigin, organizationId, deploymentId, idempotencyKey, ...extra] = argv;
  if (
    (command !== "status" && command !== "apply") ||
    !rawOrigin ||
    !organizationId ||
    !deploymentId ||
    extra.length > 0 ||
    (command === "status" && idempotencyKey !== undefined) ||
    (command === "apply" && (!idempotencyKey || !IDEMPOTENCY_KEY.test(idempotencyKey)))
  ) {
    io.stderr(
      "usage: artifact-consumer-repair.ts status <origin> <organization> <deployment>\n" +
        "       artifact-consumer-repair.ts apply <origin> <organization> <deployment> <idempotency-key>\n",
    );
    return 2;
  }

  let origin: string;
  try {
    const parsed = new URL(rawOrigin);
    const loopback = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
    if (
      (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash ||
      (parsed.pathname !== "/" && parsed.pathname !== "")
    ) {
      throw new Error("not an origin");
    }
    origin = parsed.origin;
  } catch {
    io.stderr("origin must be a bare HTTPS origin or an HTTP localhost origin\n");
    return 2;
  }

  let token: string;
  try {
    token = io.token();
  } catch (error) {
    io.stderr(`${error instanceof Error ? error.message : "owner session unavailable"}\n`);
    return 2;
  }
  const path =
    `/v1/organizations/${encodeURIComponent(organizationId)}` +
    `/artifact-consumer-repairs/${encodeURIComponent(deploymentId)}`;
  const statusResponse = await io.fetch(`${origin}${path}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const statusBody = await responseJson(statusResponse);
  if (!statusResponse.ok) {
    io.stderr(`${statusResponse.status} ${JSON.stringify(statusBody)}\n`);
    return 1;
  }
  const status = repairStatus(statusBody);
  if (!status) {
    io.stderr("server returned a malformed artifact-consumer repair status\n");
    return 1;
  }
  if (command === "status") {
    io.stdout(`${JSON.stringify(status, null, 2)}\n`);
    return 0;
  }
  if (status.state !== "actionable") {
    io.stderr(`repair is ${status.state}${status.blocker ? `: ${status.blocker}` : ""}\n`);
    return 1;
  }
  if (!idempotencyKey) return 2;

  const applyResponse = await io.fetch(`${origin}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "idempotency-key": idempotencyKey,
    },
    body: JSON.stringify({
      kind: ARTIFACT_CONSUMER_REPAIR_APPLY_FORMAT,
      planDigest: status.planDigest,
    }),
  });
  const applyBody = await responseJson(applyResponse);
  if (!applyResponse.ok) {
    io.stderr(`${applyResponse.status} ${JSON.stringify(applyBody)}\n`);
    return 1;
  }
  const receipt = resolutionReceipt(applyBody);
  if (!receipt) {
    io.stderr("server returned a malformed artifact-consumer resolution receipt\n");
    return 1;
  }
  io.stdout(`${JSON.stringify(receipt, null, 2)}\n`);
  return 0;
}

function defaultIo(): CliIo {
  return {
    fetch,
    stdout: (value) => process.stdout.write(value),
    stderr: (value) => process.stderr.write(value),
    token: () => {
      const file = process.env.TAKOSERVER_OWNER_SESSION_FILE;
      const value =
        file !== undefined
          ? readOwnerSessionFile(file)
          : process.env.TAKOSERVER_OWNER_SESSION?.trim();
      if (!value) {
        throw new Error("TAKOSERVER_OWNER_SESSION_FILE or TAKOSERVER_OWNER_SESSION is required");
      }
      return value;
    },
  };
}

/** Reads one exact bearer only after proving custody of its full filesystem path. */
export function readOwnerSessionFile(path: string): string {
  let descriptor: number | null = null;
  try {
    if (!isAbsolute(path) || resolve(path) !== path) throw new Error("unsafe");
    const parts = path.split(sep).filter(Boolean);
    let current: string = sep;
    for (const part of parts) {
      current = join(current, part);
      const status = lstatSync(current);
      if (status.isSymbolicLink() || (current !== path && !status.isDirectory())) {
        throw new Error("unsafe");
      }
    }

    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const status = fstatSync(descriptor);
    if (
      !status.isFile() ||
      status.nlink !== 1 ||
      (typeof process.getuid === "function" && status.uid !== process.getuid()) ||
      (status.mode & 0o7777) !== 0o600 ||
      status.size < OWNER_SESSION_MINIMUM_BYTES ||
      status.size > OWNER_SESSION_MAXIMUM_BYTES
    ) {
      throw new Error("unsafe");
    }
    const value = readFileSync(descriptor, "utf8");
    if (
      Buffer.byteLength(value, "utf8") !== status.size ||
      [...value].some((character) => {
        const codePoint = character.codePointAt(0);
        return codePoint === undefined || codePoint < 0x21 || codePoint > 0x7e;
      })
    ) {
      throw new Error("unsafe");
    }
    return value;
  } catch {
    throw new Error(OWNER_SESSION_FILE_ERROR);
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}

async function responseJson(response: Response): Promise<unknown> {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return { error: "non_json_response" };
  }
}

function repairStatus(value: unknown): ArtifactConsumerRepairStatus | null {
  if (!record(value) || !record(value.repair)) return null;
  const repair = value.repair;
  if (
    repair.kind !== ARTIFACT_CONSUMER_REPAIR_STATUS_FORMAT ||
    typeof repair.deploymentId !== "string" ||
    (repair.state !== "actionable" && repair.state !== "blocked" && repair.state !== "resolved") ||
    !isSha256Digest(repair.planDigest) ||
    !Number.isSafeInteger(repair.uncertaintyFence) ||
    !Number.isSafeInteger(repair.candidateManifestCount)
  ) {
    return null;
  }
  return repair as unknown as ArtifactConsumerRepairStatus;
}

function resolutionReceipt(value: unknown): ArtifactConsumerResolutionReceipt | null {
  if (!record(value) || !record(value.receipt)) return null;
  const receipt = value.receipt;
  if (
    receipt.kind !== ARTIFACT_CONSUMER_RESOLUTION_RECEIPT_FORMAT ||
    typeof receipt.receiptId !== "string" ||
    typeof receipt.deploymentId !== "string" ||
    !Number.isSafeInteger(receipt.uncertaintyFence) ||
    !isSha256Digest(receipt.planDigest) ||
    (receipt.resolution !== "terminalized_absent" &&
      receipt.resolution !== "attributed_manifest") ||
    typeof receipt.createdAt !== "string"
  ) {
    return null;
  }
  if ((receipt.resolution === "attributed_manifest") !== isSha256Digest(receipt.manifestDigest)) {
    return null;
  }
  return receipt as unknown as ArtifactConsumerResolutionReceipt;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

if (import.meta.main) {
  process.exitCode = await runArtifactConsumerRepairCli(process.argv.slice(2));
}
