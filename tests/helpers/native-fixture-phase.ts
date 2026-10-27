import { appendFileSync } from "node:fs";
import { isAbsolute } from "node:path";

type FixtureFile = "financial-origin" | "shared-auth";
type FixturePhase =
  | "fixture_begin"
  | "d1_fixture_begin"
  | "d1_fixture_ready"
  | "native_d1_begin"
  | "native_d1_ready"
  | "source_list_begin"
  | "source_list_ready"
  | "ddl_begin"
  | "ddl_first_ready"
  | "ddl_ready"
  | "setup_ready"
  | "issuer_ready"
  | "fixture_ready"
  | "signed_in_begin"
  | "signed_in_ready"
  | "body_begin"
  | "body_ready"
  | "callback_begin"
  | "callback_ready"
  | "dispose_begin"
  | "dispose_ready";

let sequence = 0;

/** Optional operator-owned test output, separate from console diagnostic oracles. */
export function beginNativeFixturePhase(file: FixtureFile) {
  const output = process.env.TAKOSERVER_TEST_NATIVE_PHASE_LOG;
  const enabled = output !== undefined && isAbsolute(output);
  const fixture = ++sequence;
  const started = enabled ? performance.now() : 0;
  return (phase: FixturePhase): void => {
    if (!enabled) return;
    try {
      // Closed labels and elapsed time only: no SDK errors, SQL, identities or values.
      appendFileSync(
        output,
        `${JSON.stringify({ file, fixture, phase, elapsedMs: Math.round(performance.now() - started) })}\n`,
        { mode: 0o600 },
      );
    } catch {
      // An unavailable diagnostic sink must preserve the original test outcome.
    }
  };
}
