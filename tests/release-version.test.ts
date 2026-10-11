import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  absoluteLinks,
  changelogSections,
  isReleaseVersion,
  releaseNotes,
} from "../scripts/release-notes.ts";
import { openApiDocument } from "../src/openapi.ts";

// The product version is stated in three places that ship: package.json, the
// OpenAPI document the Host serves at /openapi.json, and the CHANGELOG section
// the GitHub Release notes are cut from (docs/release.md). They move together.

const ROOT = resolve(import.meta.dir, "..");
const manifest = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8")) as {
  readonly version: string;
};
const changelog = readFileSync(resolve(ROOT, "CHANGELOG.md"), "utf8");

test("package.json, the OpenAPI document and its artifact carry one release version", () => {
  expect(isReleaseVersion(manifest.version)).toBe(true);
  const servedVersion: string = openApiDocument.info.version;
  expect(servedVersion).toBe(manifest.version);
  const artifact = JSON.parse(
    readFileSync(resolve(ROOT, "openapi/takoserver.openapi.json"), "utf8"),
  ) as { readonly info: { readonly version: string } };
  expect(artifact.info.version).toBe(manifest.version);
});

test("CHANGELOG.md has exactly one non-empty section for the package version", () => {
  const sections = changelogSections(changelog);
  expect(sections.filter((section) => section.version === manifest.version)).toHaveLength(1);
  expect(releaseNotes(changelog, manifest.version, { allowUnreleased: true }).trim()).not.toBe("");
  // Newest first, and no version appears twice.
  expect(sections[0]?.version).toBe(manifest.version);
  expect(new Set(sections.map((section) => section.version)).size).toBe(sections.length);
});

test("release notes are one section's body and refuse an unfinished or unknown version", () => {
  const text = [
    "# Changelog",
    "",
    "Preamble.",
    "",
    "## [2.0.0] - Unreleased",
    "",
    "### Breaking changes",
    "",
    "- two",
    "",
    "## [1.0.0] - 2026-08-20",
    "",
    "- one",
    "",
  ].join("\n");
  expect(releaseNotes(text, "1.0.0")).toBe("- one\n");
  expect(releaseNotes(text, "2.0.0", { allowUnreleased: true })).toBe(
    "### Breaking changes\n\n- two\n",
  );
  expect(() => releaseNotes(text, "2.0.0")).toThrow("still marked Unreleased");
  expect(() => releaseNotes(text, "3.0.0")).toThrow("0 sections for 3.0.0");
  expect(() => releaseNotes(text, "v2.0.0")).toThrow("not a release version");
  expect(() => releaseNotes(`${text}\n## 1.0.0\n`, "1.0.0")).toThrow("CHANGELOG heading");
  expect(() => releaseNotes("## [1.0.0] - 2026-08-20\n\n", "1.0.0")).toThrow("is empty");
});

test("a pre-release section is found by its exact version and its pending markers block it", () => {
  const text = [
    "## [2.0.0-rc.1] - 2026-10-12",
    "",
    "### Fixed",
    "",
    "- merged",
    "<!-- pending: #300 -->",
    "",
    "## [1.0.0] - 2026-08-20",
    "",
    "- one",
    "",
  ].join("\n");
  expect(isReleaseVersion("2.0.0-rc.1")).toBe(true);
  expect(isReleaseVersion("2.0.0-")).toBe(false);
  expect(() => releaseNotes(text, "2.0.0-rc.1")).toThrow("pending marker");
  expect(releaseNotes(text, "2.0.0-rc.1", { allowUnreleased: true })).toContain("- merged");
  expect(() => releaseNotes(text, "2.0.0")).toThrow("0 sections for 2.0.0");
  expect(releaseNotes(text.replace("<!-- pending: #300 -->\n", ""), "2.0.0-rc.1")).toBe(
    "### Fixed\n\n- merged\n",
  );
});

test("release notes point repository-relative links at the version's tag", () => {
  expect(
    absoluteLinks(
      "[a](docs/release.md#x) [b](https://semver.org/) [c](#local) [d](mailto:x@example.com)",
      "2.0.0-rc.1",
    ),
  ).toBe(
    "[a](https://github.com/tako0614/takoserver/blob/v2.0.0-rc.1/docs/release.md#x) " +
      "[b](https://semver.org/) [c](#local) [d](mailto:x@example.com)",
  );
  const notes = releaseNotes(changelog, manifest.version, { allowUnreleased: true });
  expect(notes).not.toMatch(/\]\((?!https:\/\/|#)/u);
});
