import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

// Ordinary bun test also uses a dedicated process: fixture mock.module calls
// cannot replace real Root imports in unrelated product tests.
test("request-owned R1 consumer runs all twenty-four external-origin scenarios in isolation", async () => {
  const child = Bun.spawn({
    cmd: [
      process.execPath,
      "--no-env-file",
      "test",
      "--timeout",
      "30000",
      "--bail=1",
      "-t",
      "^(?!identity evidence DATA)",
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
  expect({ exit, diagnostics: exit === 0 ? "" : stdout + stderr }).toEqual({
    exit: 0,
    diagnostics: "",
  });
  expect(stderr).toMatch(/(?:^|\n)\s*24 pass\s*(?:\n|$)/u);
  expect(stderr).toMatch(/(?:^|\n)\s*0 fail\s*(?:\n|$)/u);
  expect(stderr.match(/^\(pass\) /gmu)).toHaveLength(24);
  const childExpect = Number(/(\d+) expect\(\) calls/u.exec(stderr)?.[1]);
  expect(Number.isSafeInteger(childExpect) && childExpect > 0).toBe(true);
  console.info(
    JSON.stringify({
      scope: "isolated external-Root R1 fixture",
      pass: 24,
      fail: 0,
      expect: childExpect,
    }),
  );
  const { createFinancialActionConsentR1Reader } = await import(
    "../src/shared-financial-retained-r1.ts"
  );
  let callerGetterCalls = 0;
  const fake = Object.create(null, {
    query: {
      get() {
        callerGetterCalls++;
        throw Error("caller getter");
      },
    },
  });
  expect(() =>
    createFinancialActionConsentR1Reader(
      fake,
      new Request("https://fixture.invalid"),
      "workspace:test",
    ),
  ).toThrow("unavailable");
  expect(callerGetterCalls).toBe(0);
}, 100_000);
