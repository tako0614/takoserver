import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

test("consent mismatch and unselected Money epoch reject fixed SQL in an isolated process", async () => {
  const child = Bun.spawn({
    cmd: [
      process.execPath,
      "--no-env-file",
      "test",
      "--timeout",
      "60000",
      "--bail=1",
      "./tests/fixtures/financial-current-consent-origin-negative-scenario.ts",
    ],
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env: process.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout: 90_000,
  });
  const [exit, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect(stdout.length + stderr.length).toBeLessThan(32_768);
  expect({ exit, diagnostics: exit === 0 ? "" : stdout + stderr }).toEqual({
    exit: 0,
    diagnostics: "",
  });
  expect(stderr).toMatch(/(?:^|\n)\s*2 pass\s*(?:\n|$)/u);
  expect(stderr).toMatch(/(?:^|\n)\s*0 fail\s*(?:\n|$)/u);
  expect(stderr.match(/^\(pass\) /gmu)).toHaveLength(2);
}, 100_000);
