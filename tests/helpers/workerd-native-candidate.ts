export type WorkerdNativeTestInput =
  | { readonly mode: "accepted"; readonly binary: string | undefined }
  | { readonly mode: "candidate"; readonly binary: string; readonly provenance: string };

/** Candidate inputs are test-only and never configure the accepted serving selector. */
export function readWorkerdNativeTestInput(
  env: Readonly<Record<string, string | undefined>>,
): WorkerdNativeTestInput {
  const binary = env.TAKOSERVER_TEST_WORKERD_CANDIDATE_BINARY;
  const provenance = env.TAKOSERVER_TEST_WORKERD_CANDIDATE_PROVENANCE;
  if (binary === undefined && provenance === undefined) {
    return { mode: "accepted", binary: env.TAKOSERVER_WORKERD_BINARY };
  }
  if (binary === undefined || provenance === undefined) {
    throw new Error("native candidate test mode requires both candidate binary and provenance");
  }
  for (const path of [binary, provenance]) {
    if (!isAbsolute(path) || path.includes("\0")) {
      throw new Error("native candidate test inputs must be absolute paths");
    }
  }
  return { mode: "candidate", binary, provenance };
}

export function workerdNativeTestIsEnabled(
  input: WorkerdNativeTestInput,
  guardBinary: string | undefined,
): boolean {
  // An explicit candidate must fail (including missing guard), never skip.
  return input.mode === "candidate" || (input.binary !== undefined && guardBinary !== undefined);
}

/** Only native tests may select an unqualified candidate; no candidate is ever probed here. */
export async function selectWorkerdNativeTestBinary(options: {
  readonly input: WorkerdNativeTestInput;
  readonly privateRoot: string;
}): Promise<string> {
  const { input, privateRoot } = options;
  if (input.mode === "accepted") {
    const artifact = await selectClosedGraphWorkerd({ binary: input.binary, privateRoot });
    if (!artifact.binary) throw new Error(artifact.diagnostic ?? "no pinned runtime");
    return artifact.binary;
  }

  await requireRegularFile(input.provenance, false);
  const record: unknown = JSON.parse(await readFile(input.provenance, "utf8"));
  if (record === null || typeof record !== "object" || Array.isArray(record)) {
    throw new Error("native candidate provenance must be an object");
  }
  const fields = record as Record<string, unknown>;
  if (
    typeof fields.takoserverCommit !== "string" ||
    !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(fields.takoserverCommit) ||
    typeof fields.binarySha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(fields.binarySha256)
  ) {
    throw new Error("native candidate provenance requires exact commit and binary SHA-256");
  }
  // Reconstruct canonical identity from the publisher's owner pins and actual
  // local overlays/build script. Test-only commits may advance HEAD after build.
  const expected = await createWorkflowLoaderCandidateProvenance({
    takoserverCommit: fields.takoserverCommit,
    buildScriptSha256: await fileSha256(new URL("../../scripts/build-workerd.ts", import.meta.url)),
  });
  if (
    !isDeepStrictEqual(record, {
      ...expected,
      binarySha256: fields.binarySha256,
      binaryPath: input.binary,
      qualification: "unqualified-native-tests-not-run",
    })
  ) {
    throw new Error("native candidate provenance does not match the canonical combined candidate");
  }

  await requireRegularFile(input.binary, true);
  if (!isAbsolute(privateRoot)) throw new Error("native test private root must be absolute");
  await mkdir(privateRoot, { recursive: true, mode: 0o700 });
  const metadata = await lstat(privateRoot);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("native test private root must be a non-symlink directory");
  }
  await chmod(privateRoot, 0o700);
  const snapshotRoot = await mkdtemp(join(privateRoot, "candidate-"));
  try {
    const snapshot = join(snapshotRoot, `workerd-${fields.binarySha256}`);
    await copyFile(input.binary, snapshot, fsConstants.COPYFILE_EXCL);
    await chmod(snapshot, 0o500);
    await requireRegularFile(snapshot, true);
    // Hash the private copy, never trust an earlier hash of the mutable input.
    if ((await fileSha256(snapshot)) !== fields.binarySha256) {
      throw new Error("native candidate copied binary SHA-256 does not match provenance");
    }
    return snapshot;
  } catch (error) {
    await rm(snapshotRoot, { recursive: true, force: true });
    throw error;
  }
}

async function requireRegularFile(path: string, executable: boolean): Promise<void> {
  if (!isAbsolute(path) || path.includes("\0")) {
    throw new Error("native candidate input paths must be absolute");
  }
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error("native candidate input must be a regular non-symlink file");
  }
  await access(path, fsConstants.R_OK | (executable ? fsConstants.X_OK : 0));
}

async function fileSha256(path: string | URL): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
import { createHash } from "node:crypto";
import { createReadStream, constants as fsConstants } from "node:fs";
import { access, chmod, copyFile, lstat, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { createWorkflowLoaderCandidateProvenance } from "../../scripts/build-workerd.ts";
import { selectClosedGraphWorkerd } from "../../src/workerd-artifact.ts";
