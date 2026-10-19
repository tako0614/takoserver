import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPOSITORY = `${import.meta.dir}/..`;
const SURFACE = "takoserver-integration-worker-bootstrap";
const FLAG = "--repair-original-money-maintenance";
const COMMIT = "a".repeat(40);
const LOCATORS = [
  "TAKOSERVER_INTEGRATION_STORAGE_ORIGINAL_CREATE_INPUT_PATH",
  "TAKOSERVER_INTEGRATION_MONEY_MAINTENANCE_SELECTION_PATH",
  "TAKOSERVER_INTEGRATION_MONEY_MAINTENANCE_REPAIR_SELECTION_PATH",
] as const;

async function deploy(args: readonly string[], selected: Readonly<Record<string, string>> = {}) {
  const directory = mkdtempSync(join(tmpdir(), "maintenance-repair-cli-"));
  try {
    const child = Bun.spawn(
      [process.execPath, "--no-env-file", "run", "--silent", "deploy", "--", ...args],
      {
        cwd: REPOSITORY,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        env: {
          PATH: process.env.PATH ?? "",
          HOME: directory,
          TMPDIR: directory,
          TAKOSERVER_DEPLOY_TARGET_INTEGRATION: join(directory, "absent-target.json"),
          ...selected,
        },
      },
    );
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { exitCode, stdout, stderr };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function argumentsFor(surface = SURFACE, action = "apply", environment = "integration") {
  return [surface, `--${action}`, `--environment=${environment}`, `--commit=${COMMIT}`];
}

describe("original maintenance successor repair CLI scope", () => {
  for (const [name, args] of [
    ["ordinary Worker", [...argumentsFor("takoserver-worker"), FLAG]],
    ["status", [...argumentsFor(SURFACE, "status"), FLAG]],
    ["rehearsal", [...argumentsFor(SURFACE, "apply", "rehearsal"), FLAG]],
    ["production", [...argumentsFor(SURFACE, "apply", "production"), FLAG]],
    ["global repair action", argumentsFor(SURFACE, "repair")],
    ["duplicate selector", [...argumentsFor(), FLAG, FLAG]],
    ["selector value", [...argumentsFor(), `${FLAG}=true`]],
    ["closure delta", [...argumentsFor(), FLAG, "--add-var=UNRELATED"]],
  ] as const) {
    test(`refuses ${name} before dispatch`, async () => {
      const result = await deploy(args);
      expect(result.exitCode).toBe(2);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("deploy refused: no target was touched");
      expect(result.stderr).toContain("takoserver deploy");
    });
  }

  for (const missing of LOCATORS) {
    test(`requires ${missing} before loading a target`, async () => {
      const selected: Record<string, string> = {};
      for (const locator of LOCATORS) {
        if (locator !== missing) selected[locator] = "/not-read-by-this-test.json";
      }
      const result = await deploy([...argumentsFor(), FLAG], selected);
      expect(result.exitCode).toBe(2);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(`${missing} is required and must not have outer whitespace`);
      expect(result.stderr).not.toContain("deploy target descriptor not found");
      expect(result.stderr).not.toContain("takoserver deploy\n");
    });
  }

  for (const surface of [SURFACE, "takoserver-worker"]) {
    test(`refuses an ambient repair locator without the flag on ${surface}`, async () => {
      const result = await deploy(argumentsFor(surface), {
        TAKOSERVER_INTEGRATION_MONEY_MAINTENANCE_REPAIR_SELECTION_PATH:
          "/not-read-by-this-test.json",
      });
      expect(result.exitCode).toBe(2);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(
        "original money maintenance repair selection requires --repair-original-money-maintenance",
      );
      expect(result.stderr).not.toContain("deploy target descriptor not found");
    });
  }

  test("accepts only the scoped selector and reaches target loading after all three locators", async () => {
    const selected: Record<string, string> = {};
    for (const locator of LOCATORS) selected[locator] = "/not-read-by-this-test.json";
    const result = await deploy([...argumentsFor(), FLAG], selected);
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("deploy target descriptor not found");
    expect(result.stderr).toContain("absent-target.json");
    expect(result.stderr).not.toContain("takoserver deploy\n");
  });
});
