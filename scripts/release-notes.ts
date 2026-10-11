/**
 * Prints one version's CHANGELOG.md section, for `gh release create --notes-file`.
 *
 *   bun scripts/release-notes.ts 2.0.0 > "$RUN/notes-v2.0.0.md"
 *   bun scripts/release-notes.ts 2.0.0 --allow-unreleased   # preview only
 *
 * Read-only. It refuses a version that has no section, a section with an empty
 * body, and a section whose heading still says `Unreleased`, so a release is
 * never published from notes that were not finalized. See docs/release.md.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export interface ChangelogSection {
  readonly version: string;
  /** `YYYY-MM-DD`, or null while the heading says `Unreleased`. */
  readonly date: string | null;
  readonly body: string;
}

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
const SECTION_HEADING = /^## \[([^\]]+)\] - (Unreleased|\d{4}-\d{2}-\d{2})$/u;

export function isReleaseVersion(value: string): boolean {
  return SEMVER.test(value);
}

/** Every `## [x.y.z] - date` section, in file order. */
export function changelogSections(text: string): ChangelogSection[] {
  const sections: ChangelogSection[] = [];
  let current: { version: string; date: string | null; lines: string[] } | undefined;
  const finish = (): void => {
    if (current) {
      sections.push({
        version: current.version,
        date: current.date,
        body: current.lines.join("\n").trim(),
      });
    }
  };
  for (const line of text.split("\n")) {
    if (line.startsWith("## ")) {
      finish();
      const heading = SECTION_HEADING.exec(line);
      if (!heading?.[1] || !heading[2] || !isReleaseVersion(heading[1])) {
        throw new Error(`CHANGELOG heading is not "## [x.y.z] - YYYY-MM-DD|Unreleased": ${line}`);
      }
      current = {
        version: heading[1],
        date: heading[2] === "Unreleased" ? null : heading[2],
        lines: [],
      };
      continue;
    }
    current?.lines.push(line);
  }
  finish();
  return sections;
}

export function releaseNotes(
  text: string,
  version: string,
  options: { readonly allowUnreleased?: boolean } = {},
): string {
  if (!isReleaseVersion(version)) throw new Error(`not a release version: ${version}`);
  const matches = changelogSections(text).filter((section) => section.version === version);
  if (matches.length !== 1) {
    throw new Error(`CHANGELOG.md has ${matches.length} sections for ${version}; expected 1`);
  }
  const [section] = matches;
  if (!section || section.body === "") throw new Error(`CHANGELOG.md section ${version} is empty`);
  if (section.date === null && options.allowUnreleased !== true) {
    throw new Error(
      `CHANGELOG.md section ${version} is still marked Unreleased; set the release date first`,
    );
  }
  return `${section.body}\n`;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const allowUnreleased = args.includes("--allow-unreleased");
  const positional = args.filter((arg) => arg !== "--allow-unreleased");
  if (positional.length !== 1 || positional[0] === undefined) {
    process.stderr.write("usage: bun scripts/release-notes.ts <version> [--allow-unreleased]\n");
    process.exit(2);
  }
  try {
    const text = readFileSync(resolve(import.meta.dir, "../CHANGELOG.md"), "utf8");
    process.stdout.write(releaseNotes(text, positional[0], { allowUnreleased }));
  } catch (error) {
    process.stderr.write(`release-notes: ${error instanceof Error ? error.message : error}\n`);
    process.exit(1);
  }
}
