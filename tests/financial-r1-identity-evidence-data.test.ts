import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

test("R1 identity evidence DATA joins run in an isolated external-origin process", async () => {
  const child = Bun.spawn({
    cmd: [
      process.execPath,
      "--no-env-file",
      "test",
      "--timeout",
      "30000",
      "--bail=1",
      "-t",
      "^identity evidence DATA",
      "./tests/fixtures/financial-r1-request-reader-scenario.ts",
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
  // Preserve the actual child footer in the outer raw evidence.
  console.info(stdout);
  console.error(stderr);
  expect({ exit, diagnostics: exit === 0 ? "" : stdout + stderr }).toEqual({
    exit: 0,
    diagnostics: "",
  });
  expect(stderr).toMatch(/(?:^|\n)\s*9 pass\s*(?:\n|$)/u);
  expect(stderr).toMatch(/(?:^|\n)\s*0 fail\s*(?:\n|$)/u);
  expect(stderr.match(/^\(pass\) /gmu)).toHaveLength(9);
}, 100_000);
