import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyWorkerdOverlays,
  createWorkflowLoaderCandidateProvenance,
  publishWorkflowLoaderCandidate,
  type WorkerdOverlay,
  workflowLoaderCandidateOverlays,
  workflowLoaderCandidateResourceArguments,
} from "../scripts/build-workerd.ts";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("workerd WorkerLoader candidate build inputs", () => {
  test("emits separate Bazel local-resource assignments", () => {
    expect(workflowLoaderCandidateResourceArguments({ jobs: 2, memoryMiB: 8192 })).toEqual([
      "--jobs=2",
      "--local_resources=cpu=2",
      "--local_resources=memory=8192",
    ]);
  });

  test("selects both patches in closed-graph then WorkerLoader candidate order", async () => {
    const overlays = workflowLoaderCandidateOverlays();
    const calls: string[] = [];
    const execute = async (command: readonly string[]) => {
      calls.push(command.slice(3).join(" "));
    };

    await applyWorkerdOverlays("/isolated/source", overlays, execute);

    expect(overlays.map((overlay) => overlay.name)).toEqual([
      "closed-module-graph",
      "worker-loader-closed-graph-candidate",
    ]);
    expect(calls).toEqual(
      overlays.flatMap(({ path }) => [`apply --check ${path}`, `apply ${path}`]),
    );
  });

  test("binds deterministic candidate provenance to commit, script, upstream, and both patch digests", async () => {
    const first = await createWorkflowLoaderCandidateProvenance({
      takoserverCommit: "1bf21189de367c33787216c4c3b6d5d9382d3366\n",
      buildScriptSha256: "a".repeat(64),
    });
    const repeat = await createWorkflowLoaderCandidateProvenance({
      takoserverCommit: "1bf21189de367c33787216c4c3b6d5d9382d3366",
      buildScriptSha256: "a".repeat(64),
    });
    const changedSource = await createWorkflowLoaderCandidateProvenance({
      takoserverCommit: "2bf21189de367c33787216c4c3b6d5d9382d3366",
      buildScriptSha256: "a".repeat(64),
    });

    expect(first).toEqual(repeat);
    expect(first.identity).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(first.identity).not.toContain(
      "c00638f195e4a9fda4bafb07bb7b1674e4d8324d0072efbf0ea57beb0ff08e52",
    );
    expect(first.overlays.map(({ name }) => name)).toEqual([
      "closed-module-graph",
      "worker-loader-closed-graph-candidate",
    ]);
    expect(first.toolchain).toMatchObject({
      bazeliskSha256: expect.any(String),
      bazelSha256: expect.any(String),
      clangVersion: expect.stringContaining("clang version 20.1.8"),
      platform: "linux",
      arch: "x64",
    });
    expect(first.nativeQualification).toBe("not-run");
    expect(changedSource.identity).not.toBe(first.identity);
  });

  test("refuses incomplete provenance inputs", async () => {
    await expect(
      createWorkflowLoaderCandidateProvenance({
        takoserverCommit: "1bf2118",
        buildScriptSha256: "a".repeat(64),
      }),
    ).rejects.toThrow("full Takoserver commit hash");
    await expect(
      createWorkflowLoaderCandidateProvenance({
        takoserverCommit: "1".repeat(41),
        buildScriptSha256: "a".repeat(64),
      }),
    ).rejects.toThrow("full Takoserver commit hash");
    await expect(
      createWorkflowLoaderCandidateProvenance({
        takoserverCommit: "1bf21189de367c33787216c4c3b6d5d9382d3366",
        buildScriptSha256: "not-a-digest",
      }),
    ).rejects.toThrow("build-script SHA-256");
  });

  test("refuses a changed candidate patch before invoking patch application", async () => {
    const overlays = workflowLoaderCandidateOverlays();
    const activeOverlay = overlays[0];
    const candidateOverlay = overlays[1];
    if (activeOverlay === undefined || candidateOverlay === undefined) {
      throw new Error("candidate overlays missing");
    }
    const changedCandidate: WorkerdOverlay = {
      ...candidateOverlay,
      sha256: "0".repeat(64),
    };
    const calls: string[] = [];

    await expect(
      applyWorkerdOverlays(
        "/isolated/source",
        [activeOverlay, changedCandidate],
        async (command) => {
          calls.push(command.join(" "));
        },
      ),
    ).rejects.toThrow(/worker-loader-closed-graph-candidate overlay patch digest/u);

    expect(calls).toEqual([]);
  });

  test("applies sequential patch contexts and refuses the candidate patch on an unpatched source", async () => {
    const root = await temporaryDirectory();
    const source = join(root, "source");
    await mkdir(source);
    await writeFile(join(source, "entry.txt"), "base\n", { encoding: "utf8" });
    const active = await fixtureOverlay(root, "active.patch", ["base", "active"]);
    const candidate = await fixtureOverlay(root, "candidate.patch", ["active", "candidate"]);

    await applyWorkerdOverlays(source, [active, candidate]);
    await expect(readFile(join(source, "entry.txt"), "utf8")).resolves.toBe("candidate\n");

    const cleanSource = join(root, "clean-source");
    await mkdir(cleanSource);
    await writeFile(join(cleanSource, "entry.txt"), "base\n", { encoding: "utf8" });
    await expect(applyWorkerdOverlays(cleanSource, [candidate, active])).rejects.toThrow();
    await expect(readFile(join(cleanSource, "entry.txt"), "utf8")).resolves.toBe("base\n");
  });

  test("publishes only in a distinct candidate namespace and refuses overwrite", async () => {
    const root = await temporaryDirectory();
    const artifactsRoot = join(root, "artifacts");
    await mkdir(artifactsRoot, { recursive: true });
    const acceptedArtifact = join(
      artifactsRoot,
      "workerd-c00638f195e4a9fda4bafb07bb7b1674e4d8324d0072efbf0ea57beb0ff08e52",
    );
    await writeFile(acceptedArtifact, "accepted artifact stays untouched", { encoding: "utf8" });
    const built = join(root, "built-workerd");
    await writeFile(built, "candidate native binary", { encoding: "utf8" });
    const provenance = await createWorkflowLoaderCandidateProvenance({
      takoserverCommit: "1bf21189de367c33787216c4c3b6d5d9382d3366",
      buildScriptSha256: "b".repeat(64),
    });

    const published = await publishWorkflowLoaderCandidate({ built, artifactsRoot, provenance });
    const binaryDigest = createHash("sha256").update("candidate native binary").digest("hex");
    const record = JSON.parse(await readFile(published.provenance, "utf8")) as {
      readonly binarySha256: string;
      readonly binaryPath: string;
      readonly qualification: string;
      readonly nativeQualification: string;
    };

    expect(published.artifact).toContain(
      `/candidates/${provenance.identity.slice("sha256:".length)}/`,
    );
    expect(published.artifact).not.toBe(acceptedArtifact);
    expect(published.sha256).toBe(binaryDigest);
    const copiedBytesDigest = createHash("sha256")
      .update(await readFile(published.artifact))
      .digest("hex");
    expect(published.sha256).toBe(copiedBytesDigest);
    expect(published.artifact).toEndWith(`/workerd-${copiedBytesDigest}`);
    expect(record).toMatchObject({
      binarySha256: binaryDigest,
      binaryPath: published.artifact,
      qualification: "unqualified-native-tests-not-run",
      nativeQualification: "not-run",
    });
    await expect(readFile(record.binaryPath, "utf8")).resolves.toBe(
      await readFile(published.artifact, "utf8"),
    );
    await expect(readFile(acceptedArtifact, "utf8")).resolves.toBe(
      "accepted artifact stays untouched",
    );
    await expect(
      publishWorkflowLoaderCandidate({ built, artifactsRoot, provenance }),
    ).rejects.toThrow();
    await expect(readFile(acceptedArtifact, "utf8")).resolves.toBe(
      "accepted artifact stays untouched",
    );
  });
});

async function temporaryDirectory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "takoserver-workerd-candidate-test-"));
  temporaryRoots.push(root);
  return root;
}

async function fixtureOverlay(
  root: string,
  name: string,
  [before, after]: readonly [string, string],
): Promise<WorkerdOverlay> {
  const path = join(root, name);
  const patch = `diff --git a/entry.txt b/entry.txt\n--- a/entry.txt\n+++ b/entry.txt\n@@ -1 +1 @@\n-${before}\n+${after}\n`;
  await writeFile(path, patch, { encoding: "utf8" });
  return {
    name,
    path,
    sha256: createHash("sha256").update(patch).digest("hex"),
  };
}
