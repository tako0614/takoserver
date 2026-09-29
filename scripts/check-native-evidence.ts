/**
 * Reports which native evidence a `bun run check` run did and did not prove.
 *
 * The portable gate cannot supply the pinned closed-graph workerd artifact or
 * the Actor qualification candidate, so the tests that need them skip. This
 * phase makes that state explicit instead of leaving it to be discovered later.
 * See `scripts/native-evidence.ts` for the rules.
 */

import { resolve } from "node:path";

import {
  collectNativeEvidenceGates,
  hostProbe,
  nativeEvidenceExitCode,
  renderNativeEvidenceReport,
  summarizeNativeEvidence,
} from "./native-evidence.ts";

const gates = collectNativeEvidenceGates(resolve(import.meta.dir, "../tests"));
const summaries = summarizeNativeEvidence({ gates, environment: process.env, probe: hostProbe });
for (const line of renderNativeEvidenceReport({ summaries, gates })) {
  process.stdout.write(`${line}\n`);
}
process.exit(nativeEvidenceExitCode({ summaries, gates }));
