// Preloaded once per test file by scripts/run-tests.ts. Under --parallel,
// files share worker processes and the workers share the host, but several
// deploy and self-host paths root host-wide state in TMPDIR (Worker Version
// publication lease locks, sockets, lock directories). Each file therefore runs
// with its own private TMPDIR, so two files can never meet through those paths
// while each production default stays as is. The directory sits directly in
// the run's TMPDIR with an 8-byte name, because Unix socket paths built under
// it must stay within their 100-byte budget. Its name is recorded so the runner
// removes it after the run (workers exit without running exit handlers).
import { mkdtempSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

const base = process.env.TAKOSERVER_TEST_TMPDIR_BASE;
const registry = process.env.TAKOSERVER_TEST_TMPDIR_REGISTRY;
if (base === undefined || registry === undefined)
  throw new Error("run the suite through scripts/run-tests.ts");
const directory = mkdtempSync(join(base, "t"));
writeFileSync(join(registry, basename(directory)), "", { flag: "wx" });
process.env.TMPDIR = directory;
