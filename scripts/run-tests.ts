// Runs the portable test suite in isolated parallel worker processes.
//
//   bun run test                  complete gate: every test file, all must run
//   bun run test:changed          development: only files Bun's import graph
//                                 links to changes against origin/main
//                                 (`bun scripts/run-tests.ts --changed=<ref>`
//                                 picks another base). Files read at runtime
//                                 (SQL, config) do not select tests, so this is
//                                 a fast check, not the gate.
//
// --parallel implies --isolate: each test file gets a fresh global scope and
// module registry, so process-wide module mocks and singletons cannot cross
// files. A complete run fails unless Bun's final summary covers every test file
// in the repository, so a crashed worker, an empty discovery or a partial run
// cannot pass as success. Recorded per-file durations only order the work
// (slowest first); they never select or skip files.
//
// Afterwards the runner prints the slowest files, the summed per-file time,
// how well the workers were kept busy, and any file far slower than its
// recorded duration, so a regression is visible in every gate log. The
// per-file durations of the run are written outside the repository (path
// printed); copying them over tests/test-timings.json refreshes the ordering.
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Glob } from "bun";

const ROOT = resolve(import.meta.dir, "..");
const TIMINGS = "tests/test-timings.json";
const args = process.argv.slice(2);
const changedIndex = args.findIndex((arg) => arg === "--changed" || arg.startsWith("--changed="));
const scoped = changedIndex >= 0;
if (scoped && args[changedIndex] === "--changed") args[changedIndex] = "--changed=origin/main";

// Every file name pattern `bun test` discovers, so the count below cannot be
// satisfied by an unexpected file standing in for one that never ran.
const discovered = [
  ...new Glob("**/*{.test,_test,.spec,_spec}.{ts,tsx,js,jsx,mts,cts,mjs,cjs}").scanSync({
    cwd: ROOT,
  }),
].filter((path) => !path.split("/").includes("node_modules"));
const expected = discovered.length;
if (expected === 0) throw new Error("no test files found");

// The CPUs this process may actually use: the affinity set, further limited
// by a cgroup v2 CPU quota (containers often report every host CPU).
function usableCpus(): number {
  let cpus = availableParallelism();
  try {
    const [quota, period] = readFileSync("/sys/fs/cgroup/cpu.max", "utf8").trim().split(/\s+/u);
    const limit = Math.floor(Number(quota) / Number(period));
    if (quota !== "max" && Number.isFinite(limit)) cpus = Math.min(cpus, Math.max(1, limit));
  } catch {}
  return cpus;
}

// Many files start workerd, Miniflare or child processes of their own, so one
// worker per CPU oversubscribes the host and pushes real-runtime tests past
// their deadlines. Half the usable CPUs (at least one) leaves that headroom.
const selected = process.env.TAKOSERVER_TEST_WORKERS;
if (selected !== undefined && !/^[1-9][0-9]?$/u.test(selected))
  throw new Error("TAKOSERVER_TEST_WORKERS must be a worker count from 1 to 99");
const workers = Number(selected ?? Math.max(1, Math.floor(usableCpus() / 2)));

// Run-scoped directories: per-file TMPDIR registry, a cache that test helpers
// may fill with content-addressed build results (cold at every run start, so
// a source or toolchain change can never be served stale), and the report.
const registry = mkdtempSync(join(tmpdir(), "treg"));
const cache = mkdtempSync(join(tmpdir(), "tcache"));
const report = join(mkdtempSync(join(tmpdir(), "takoserver-test-report-")), "timings.json");
const recorded = existsSync(resolve(ROOT, TIMINGS))
  ? (JSON.parse(readFileSync(resolve(ROOT, TIMINGS), "utf8")) as {
      files: Record<string, number>;
    })
  : { files: {} };
if (existsSync(resolve(ROOT, TIMINGS))) copyFileSync(resolve(ROOT, TIMINGS), report);
else await Bun.write(report, JSON.stringify({ version: 1, files: {} }));

const started = performance.now();
const child = Bun.spawn(
  [
    process.execPath,
    "test",
    "--timeout",
    "60000",
    "--bail=1",
    `--parallel=${workers}`,
    "--preload=./tests/preload-isolated-tmpdir.ts",
    "--preload=./tests/preload-miniflare-native-http.ts",
    `--timings=${report}`,
    "--update-timings",
    ...args,
  ],
  {
    cwd: ROOT,
    // Each test file gets its own private TMPDIR (tests/preload-isolated-tmpdir.ts).
    env: {
      ...process.env,
      TAKOSERVER_TEST_TMPDIR_BASE: tmpdir(),
      TAKOSERVER_TEST_TMPDIR_REGISTRY: registry,
      TAKOSERVER_TEST_CACHE_DIR: cache,
    },
    stdin: "inherit",
    stdout: "inherit",
    stderr: "pipe",
  },
);

// Bun prints its summary on stderr. Forward everything unchanged and keep a
// tail; a child `bun test` started by a test may print its own summary
// earlier, so only the last one belongs to this run.
let tail = "";
const decoder = new TextDecoder();
for await (const chunk of child.stderr) {
  process.stderr.write(chunk);
  tail = (tail + decoder.decode(chunk, { stream: true })).slice(-16_384);
}
const exitCode = await child.exited;
const wallSeconds = (performance.now() - started) / 1000;
// Cleanup is best effort: a directory a test left unwritable must not turn a
// passing run into a failure (or hide a failing one).
for (const path of [
  ...readdirSync(registry).map((name) => join(tmpdir(), name)),
  registry,
  cache,
]) {
  try {
    rmSync(path, { recursive: true, force: true });
  } catch (error) {
    process.stderr.write(`could not remove test directory ${path}: ${String(error)}\n`);
  }
}

const summaries = [...tail.matchAll(/^Ran (\d+) tests? across (\d+) files?\./gmu)];
const files = summaries.at(-1)?.[2];
printTimings(files === undefined ? 0 : Number(files));
if (exitCode !== 0) process.exit(exitCode);
if (files === undefined) {
  process.stderr.write("test run printed no summary; refusing to report success\n");
  process.exit(1);
}
if (scoped) {
  process.stderr.write(`scoped run: ${files} affected test files (complete gate: ${expected})\n`);
} else if (Number(files) !== expected) {
  process.stderr.write(`test run covered ${files} of ${expected} test files\n`);
  process.exit(1);
}

/** Slowest files, summed per-file time, worker utilisation and regressions. */
function printTimings(ran: number): void {
  let measured: Record<string, number>;
  try {
    measured = (JSON.parse(readFileSync(report, "utf8")) as { files: Record<string, number> })
      .files;
  } catch {
    return;
  }
  // The report merges this run into the recorded baseline; keep only files
  // whose duration this run changed or that the baseline did not have.
  const run = Object.entries(measured).filter(
    ([file, ms]) => recorded.files[file] !== ms || !(file in recorded.files),
  );
  if (run.length === 0) return;
  const total = run.reduce((sum, [, ms]) => sum + ms, 0) / 1000;
  const slowest = [...run].sort((a, b) => b[1] - a[1]);
  const lines = [
    `test timings: ${ran} files, ${total.toFixed(0)} s summed per-file time, ${wallSeconds.toFixed(0)} s wall on ${workers} workers (${((100 * total) / (workers * wallSeconds)).toFixed(0)}% busy)`,
    "slowest files:",
    ...slowest
      .slice(0, 15)
      .map(([file, ms]) => `  ${(ms / 1000).toFixed(1).padStart(6)} s  ${file}`),
  ];
  // Timing is noisy, so only a large jump is reported, and it never fails the run.
  const regressions = slowest.filter(([file, ms]) => {
    const before = recorded.files[file];
    return before !== undefined && ms > 2 * before && ms - before > 15_000;
  });
  if (regressions.length > 0)
    lines.push(
      "much slower than tests/test-timings.json:",
      ...regressions.map(
        ([file, ms]) =>
          `  ${(ms / 1000).toFixed(1).padStart(6)} s (was ${((recorded.files[file] ?? 0) / 1000).toFixed(1)} s)  ${file}`,
      ),
    );
  lines.push(`per-file durations of this run: ${report}`);
  process.stderr.write(`${lines.join("\n")}\n`);
}
