import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  CURRENT_PUBLISHER_BINDING_SET_SHA256,
  CURRENT_PUBLISHER_COMMIT,
  CURRENT_PUBLISHER_FAMILY_CONFORMANCE_SHA256,
  CURRENT_PUBLISHER_FAMILY_INDEX_SHA256,
  CURRENT_PUBLISHER_REPOSITORY,
  loadCurrentPublisherCatalog,
} from "../src/takoform/current-publisher-catalog.ts";

const PUBLISHER_ROOT = publisherRoot();
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("current publisher package corpus", () => {
  test("loads only the current Edge family with exact unsigned provenance and counts", async () => {
    const catalog = await loadCurrentPublisherCatalog(PUBLISHER_ROOT);

    expect(catalog.provenance).toEqual({
      classification: "public-unsigned-package-corpus",
      repository: CURRENT_PUBLISHER_REPOSITORY,
      commit: CURRENT_PUBLISHER_COMMIT,
      gitTags: "unsigned",
      sigstoreBundle: null,
      familyIndexSha256: `sha256:${CURRENT_PUBLISHER_FAMILY_INDEX_SHA256}`,
      familyConformanceSha256: `sha256:${CURRENT_PUBLISHER_FAMILY_CONFORMANCE_SHA256}`,
      interfaceCandidateSetSha256:
        "sha256:9d15d44047369cf7866c4570293e4f40f346873eb646d82f676a3b411156ba2b",
      bindingCandidateSetSha256: `sha256:${CURRENT_PUBLISHER_BINDING_SET_SHA256}`,
      familyCount: 1,
      formCount: 16,
      interfaceCount: 7,
      bindingCount: 6,
    });
    expect(catalog.forms).toHaveLength(16);
    expect(catalog.bindings).toHaveLength(6);
    expect(new Set(catalog.forms.map((form) => form.identity.formRef.kind)).size).toBe(16);
    expect(
      catalog.forms.every((form) => form.identity.formRef.apiVersion === "edge.forms.takoform.com"),
    ).toBe(true);
  });

  test("rejects a source with the wrong repository", async () => {
    const root = clonePublisher();
    git(root, "remote", "set-url", "origin", "https://example.invalid/not-the-publisher.git");

    await expect(loadCurrentPublisherCatalog(root)).rejects.toThrow(
      "current_publisher_source_identity_drifted",
    );
  });

  test("rejects a source at the wrong commit", async () => {
    const root = clonePublisher();
    git(root, "config", "user.email", "tests@example.invalid");
    git(root, "config", "user.name", "tests");
    git(root, "commit", "--allow-empty", "-m", "wrong source commit");

    await expect(loadCurrentPublisherCatalog(root)).rejects.toThrow(
      "current_publisher_source_identity_drifted",
    );
  });

  test("rejects a dirty source before reading corpus files", async () => {
    const root = clonePublisher();
    writeFileSync(join(root, "dirty-source-marker"), "dirty\n");

    await expect(loadCurrentPublisherCatalog(root)).rejects.toThrow(
      "current_publisher_source_dirty",
    );
  });

  test("rejects a family-index digest drift even when Git reports a clean source", async () => {
    const root = clonePublisher();
    const path = join(root, "forms/candidates/current-family-index.json");
    writeFileSync(path, `${await Bun.file(path).text()}\n`);
    git(root, "update-index", "--assume-unchanged", "forms/candidates/current-family-index.json");

    await expect(loadCurrentPublisherCatalog(root)).rejects.toThrow(
      "current_publisher_input_mismatch",
    );
  });

  test("rejects a candidate count drift even when Git reports a clean source", async () => {
    const root = clonePublisher();
    const path = join(root, "forms/candidates/edge.forms.takoform.com/candidate-set.json");
    const candidateSet = JSON.parse(await Bun.file(path).text()) as {
      forms: unknown[];
    };
    candidateSet.forms = candidateSet.forms.slice(0, 15);
    writeFileSync(path, `${JSON.stringify(candidateSet, null, 2)}\n`);
    git(
      root,
      "update-index",
      "--assume-unchanged",
      "forms/candidates/edge.forms.takoform.com/candidate-set.json",
    );

    await expect(loadCurrentPublisherCatalog(root)).rejects.toThrow(
      "current_publisher_input_mismatch",
    );
  });
});

function publisherRoot(): string {
  const configured = process.env.TAKOFORM_FORMS_ROOT;
  if (configured && existsSync(join(configured, ".git"))) return resolve(configured);
  const candidates = [
    "/root/dev/takos/takoform-forms",
    resolve(import.meta.dir, "../../takoform-forms"),
    resolve(import.meta.dir, "../../../takoform-forms"),
  ];
  const root = candidates.find((candidate) => existsSync(join(candidate, ".git")));
  if (!root) throw new Error("canonical takoform-forms checkout is unavailable");
  return root;
}

function clonePublisher(): string {
  const root = mkdtempSync(join(tmpdir(), "takoserver-current-publisher-"));
  temporaryRoots.push(root);
  execFileSync("git", ["clone", "--shared", "--quiet", PUBLISHER_ROOT, root]);
  git(root, "remote", "set-url", "origin", CURRENT_PUBLISHER_REPOSITORY);
  return root;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}
