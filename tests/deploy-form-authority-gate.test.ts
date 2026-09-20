import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { DeployError } from "../scripts/deploy/errors.ts";
import { runFormAuthorityCodeGate } from "../scripts/deploy/form-authority-gate.ts";

describe("ordinary integration Form code gate", () => {
  test.each([
    ["takoserver-form-authority-identity-probe", "tests/form-authority-identity-probe.test.ts"],
    ["takoserver-form-authority-worker", "tests/takoform-core-verifier-adapter.test.ts"],
    [
      "takoserver-integration-form-authority-worker",
      "tests/takoform-integration-operator-endpoint.test.ts",
    ],
    [
      "takoserver-integration-form-authority-operator-worker",
      "tests/integration-form-authority-gateway.test.ts",
    ],
  ] as const)(
    "checks the real runtime and deploy boundary for %s",
    async (surface, runtimeTest) => {
      const calls: (readonly string[])[] = [];
      await runFormAuthorityCodeGate(async (command) => {
        calls.push(command);
        return { exitCode: 0, stdout: "", stderr: "" };
      }, surface);

      expect(calls).not.toContainEqual(["bun", "run", "check"]);
      expect(calls).toContainEqual(["bun", "run", "typecheck"]);
      expect(calls).toContainEqual(["bun", "run", "typecheck:form-authority-worker"]);
      expect(calls).toContainEqual(["bun", "run", "check:form-authority-worker-types"]);
      expect(calls).toContainEqual(["bun", "run", "check:imports"]);
      expect(calls).toContainEqual(["bun", "run", "check:form-corpora"]);
      expect(calls).toContainEqual(["bun", "run", "check:integration-form-packages"]);
      expect(calls.at(-1)).toEqual(["bun", "run", "build:form-authority-worker"]);
      const testCalls = calls.filter((command) => command[1] === "test");
      expect(testCalls).toHaveLength(1);
      const tests = testCalls[0]?.slice(2) ?? [];
      expect(tests).toContain(runtimeTest);
      expect(tests).toContain("tests/deploy-worker-artifact.test.ts");
      expect(tests).toContain("tests/takoform-static-authority-boundary.test.ts");
      expect(new Set(tests).size).toBe(tests.length);
      for (const path of tests) expect(existsSync(path)).toBe(true);
    },
  );

  test("stops at the first failed check before later tests or builds", async () => {
    const calls: (readonly string[])[] = [];
    const failure = await runFormAuthorityCodeGate(async (command) => {
      calls.push(command);
      return { exitCode: 2, stdout: "", stderr: "type failure" };
    }, "takoserver-form-authority-worker").catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(DeployError);
    expect((failure as DeployError).phase).toBe("preflight");
    expect(calls).toEqual([["bun", "run", "typecheck"]]);
  });
});
