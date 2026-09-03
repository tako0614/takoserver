/**
 * Writes (or checks) the published sponsorship seam fixture.
 *
 *   bun scripts/generate-sponsorship-seam.ts          # record
 *   bun scripts/generate-sponsorship-seam.ts --check  # refuse on drift
 *
 * The artifact is a recording of a real session against a composed Host, not a
 * description of one, so a consumer that pins the file is pinning behaviour
 * this Host proved rather than prose either side wrote.
 */
import { readFileSync } from "node:fs";
import { observeSponsorshipSeam } from "./sponsorship-seam-session.ts";

const ARTIFACT_PATH = "seams/takoserver.sponsorship-seam.json";

const rendered = `${JSON.stringify(await observeSponsorshipSeam(), null, 2)}\n`;

if (process.argv.includes("--check")) {
  const actual = readFileSync(ARTIFACT_PATH, "utf8");
  if (actual !== rendered) {
    console.error(`${ARTIFACT_PATH} is stale; run \`bun run seam:write\``);
    process.exit(1);
  }
} else {
  await Bun.write(ARTIFACT_PATH, rendered);
}
