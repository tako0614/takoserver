import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommandResult } from "../scripts/deploy/process.ts";
import {
  type QualificationProcess,
  qualifySource,
  removeArtifactTree,
  sealDirectory,
  unsealDirectory,
} from "../scripts/deploy/qualification.ts";

const COMMIT = "a".repeat(40);

function gitProcess(input: {
  readonly branch: string;
  readonly dirty?: string;
  readonly remoteCommit?: string;
  readonly remoteContains?: string;
}): { readonly run: QualificationProcess; readonly calls: string[][] } {
  const calls: string[][] = [];
  const run: QualificationProcess = async (command): Promise<CommandResult> => {
    calls.push([...command]);
    const key = command.join(" ");
    if (key === "git rev-parse HEAD") return ok(`${COMMIT}\n`);
    if (key === "git branch --show-current") return ok(`${input.branch}\n`);
    if (key === "git status --porcelain=v1 -z --untracked-files=all") {
      return ok(input.dirty ?? "");
    }
    if (key === "git fetch --quiet origin main") return ok("");
    if (key === "git rev-parse origin/main") return ok(`${input.remoteCommit ?? COMMIT}\n`);
    if (key === "git fetch --quiet --all --prune") return ok("");
    if (key === `git branch -r --contains ${COMMIT}`) {
      return ok(input.remoteContains ?? "  origin/release-candidate\n");
    }
    throw new Error(`unexpected command: ${key}`);
  };
  return { run, calls };
}

function ok(stdout: string): CommandResult {
  return { exitCode: 0, stdout, stderr: "" };
}

describe("exact source qualification", () => {
  test("allows a dirty integration source but binds it to explicit HEAD", async () => {
    const fake = gitProcess({ branch: "feature/split", dirty: " M scripts/deploy.ts\0" });
    const source = await qualifySource({
      environment: "integration",
      commit: COMMIT,
      run: fake.run,
    });
    expect(source).toMatchObject({
      commit: COMMIT,
      branch: "feature/split",
      dirty: true,
      changedPaths: ["scripts/deploy.ts"],
    });
    expect(fake.calls.some((call) => call[1] === "fetch")).toBe(false);
  });

  test("can require clean remote-reachable provenance without changing routine integration", async () => {
    const dirty = gitProcess({
      branch: "release/candidate",
      dirty: " M src/entry-exact-artifact-recovery-worker.ts\0",
    });
    await expect(
      qualifySource({
        environment: "integration",
        commit: COMMIT,
        policy: "clean-remote",
        run: dirty.run,
      }),
    ).rejects.toThrow("clean");
    expect(dirty.calls.some((call) => call[1] === "fetch")).toBe(false);

    const clean = gitProcess({ branch: "release/candidate" });
    const source = await qualifySource({
      environment: "integration",
      commit: COMMIT,
      policy: "clean-remote",
      run: clean.run,
    });
    expect(source).toMatchObject({
      commit: COMMIT,
      dirty: false,
      changedPaths: [],
      remoteRef: "origin/release-candidate",
    });
  });

  test("requires clean production main equal to freshly fetched origin/main", async () => {
    const fake = gitProcess({ branch: "main" });
    const source = await qualifySource({
      environment: "production",
      commit: COMMIT,
      run: fake.run,
    });
    expect(source.remoteRef).toBe("origin/main");
    expect(fake.calls).toContainEqual(["git", "fetch", "--quiet", "origin", "main"]);
  });

  test("accepts a clean exact production HEAD reachable from a remote ref", async () => {
    const fake = gitProcess({ branch: "release/candidate" });
    const source = await qualifySource({
      environment: "production",
      commit: COMMIT,
      run: fake.run,
    });
    expect(source.remoteRef).toBe("origin/release-candidate");
  });

  test("refuses dirty or unreachable production source", async () => {
    const dirty = gitProcess({ branch: "release/candidate", dirty: "?? local.txt\0" });
    await expect(
      qualifySource({ environment: "production", commit: COMMIT, run: dirty.run }),
    ).rejects.toThrow("clean");

    const unreachable = gitProcess({ branch: "release/candidate", remoteContains: "" });
    await expect(
      qualifySource({ environment: "production", commit: COMMIT, run: unreachable.run }),
    ).rejects.toThrow("remote ref");
  });
});

describe("sealed link-free artifacts", () => {
  test("binds every path and detects any post-seal byte change", () => {
    const root = mkdtempSync(join(tmpdir(), "takoserver-seal-"));
    try {
      mkdirSync(join(root, "nested"));
      writeFileSync(join(root, "index.js"), "one");
      writeFileSync(join(root, "nested", "config.json"), "{}\n");
      const artifact = sealDirectory(root, ["index.js", "nested/config.json"]);
      expect(artifact.files).toBe(2);
      expect(() => artifact.assertUnchanged()).not.toThrow();
      expect({
        root: statSync(root).mode & 0o777,
        nested: statSync(join(root, "nested")).mode & 0o777,
        file: statSync(join(root, "index.js")).mode & 0o777,
      }).toEqual({ root: 0o500, nested: 0o500, file: 0o400 });

      // Sealing removes write permission, so a tamper has to restore it first.
      // The recorded identity must still catch the changed bytes afterwards.
      unsealDirectory(root);
      chmodSync(join(root, "index.js"), 0o600);
      writeFileSync(join(root, "index.js"), "two");
      expect(() => artifact.assertUnchanged()).toThrow("changed after it was sealed");
    } finally {
      removeArtifactTree(root);
    }
  });

  test("refuses symbolic links and multiply-linked files", () => {
    for (const kind of ["symbolic", "hard"] as const) {
      const root = mkdtempSync(join(tmpdir(), "takoserver-link-"));
      try {
        writeFileSync(join(root, "bundle.js"), "bundle");
        if (kind === "symbolic") symlinkSync("bundle.js", join(root, "alias.js"));
        else linkSync(join(root, "bundle.js"), join(root, "alias.js"));
        expect(() => sealDirectory(root)).toThrow("link-free");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });
});
