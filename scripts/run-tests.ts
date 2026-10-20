// Runs the complete portable test suite in isolated parallel worker processes.
// --parallel implies --isolate: each test file gets a fresh global scope and
// module registry, so process-wide module mocks and singletons cannot cross
// files. The run fails unless Bun's final summary covers every test file in
// the repository, so a crashed worker, an empty discovery or a partial run
// cannot pass as success. Recorded per-file durations only order the work
// (slowest first); they never select or skip files.
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Glob } from "bun";

const ROOT = resolve(import.meta.dir, "..");
const TIMINGS = "tests/test-timings.json";
// Every file name pattern `bun test` discovers, so the count below cannot be
// satisfied by an unexpected file standing in for one that never ran.
const discovered = [
  ...new Glob("**/*{.test,_test,.spec,_spec}.{ts,tsx,js,jsx,mts,cts,mjs,cjs}").scanSync({
    cwd: ROOT,
  }),
].filter((path) => !path.split("/").includes("node_modules"));
const expected = discovered.length;
if (expected === 0) throw new Error("no test files found");

// Many files start workerd, Miniflare or child processes of their own, so one
// worker per CPU oversubscribes the host and pushes real-runtime tests past
// their deadlines. Half the CPUs (at least one) leaves that headroom.
const selected = process.env.TAKOSERVER_TEST_WORKERS;
if (selected !== undefined && !/^[1-9][0-9]?$/u.test(selected))
  throw new Error("TAKOSERVER_TEST_WORKERS must be a worker count from 1 to 99");
const workers = selected ?? String(Math.max(1, Math.floor(availableParallelism() / 2)));

const registry = mkdtempSync(join(tmpdir(), "treg"));
const child = Bun.spawn(
  [
    process.execPath,
    "test",
    "--timeout",
    "60000",
    "--bail=1",
    `--parallel=${workers}`,
    "--preload=./tests/preload-isolated-tmpdir.ts",
    ...(existsSync(resolve(ROOT, TIMINGS)) ? [`--timings=${TIMINGS}`] : []),
    ...process.argv.slice(2),
  ],
  {
    cwd: ROOT,
    // Each test file gets its own private TMPDIR (tests/preload-isolated-tmpdir.ts).
    env: {
      ...process.env,
      TAKOSERVER_TEST_TMPDIR_BASE: tmpdir(),
      TAKOSERVER_TEST_TMPDIR_REGISTRY: registry,
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
// Cleanup is best effort: a directory a test left unwritable must not turn a
// passing run into a failure (or hide a failing one).
for (const path of [...readdirSync(registry).map((name) => join(tmpdir(), name)), registry]) {
  try {
    rmSync(path, { recursive: true, force: true });
  } catch (error) {
    process.stderr.write(`could not remove test directory ${path}: ${String(error)}\n`);
  }
}
if (exitCode !== 0) process.exit(exitCode);

const summaries = [...tail.matchAll(/^Ran (\d+) tests? across (\d+) files?\./gmu)];
const files = summaries.at(-1)?.[2];
if (files === undefined) {
  process.stderr.write("test run printed no summary; refusing to report success\n");
  process.exit(1);
}
if (Number(files) !== expected) {
  process.stderr.write(`test run covered ${files} of ${expected} test files\n`);
  process.exit(1);
}
