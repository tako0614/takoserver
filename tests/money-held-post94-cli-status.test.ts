import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { SCHEMA_WAVE_BOUNDARIES } from "../scripts/deploy/schema.ts";
import { readMoneyUnitHeldPost94ConsumerInputs } from "../scripts/deploy/schema-money-unit-owner.ts";

// Local CLI/origin mechanics only. No native held preparation or Financial grant is minted.
const root = resolve(import.meta.dir, "..");
const home = mkdtempSync(join(tmpdir(), "held-cli-"));
const originalLocator = "TAKOSERVER_INTEGRATION_STORAGE_ORIGINAL_CREATE_INPUT_PATH";
const convertLocator = "TAKOSERVER_D1_MONEY_CUTOVER_DECLARATION_PATH";
const post94Locator = "TAKOSERVER_D1_MONEY_POST94_DECLARATION_PATH";
const normalLocator = "TAKOSERVER_D1_MONEY_NORMAL_WORKER_SELECTOR_PATH";
const locatorNames = [convertLocator, post94Locator, normalLocator];
const absentPath = join(home, "not-created.json");
const flags = [
  "--status",
  "--environment=integration",
  `--commit=${"a".repeat(40)}`,
  "--through-migration=0098",
];

afterAll(() => rmSync(home, { recursive: true, force: true }));

async function cli(args: readonly string[], locators: Readonly<Record<string, string>> = {}) {
  const child = Bun.spawn(
    [process.execPath, "--no-env-file", join(root, "scripts/deploy.ts"), ...args],
    {
      cwd: root,
      env: {
        PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
        HOME: home,
        TMPDIR: home,
        XDG_CACHE_HOME: home,
        XDG_CONFIG_HOME: home,
        BUN_RUNTIME_TRANSPILER_CACHE_PATH: join(home, "transpiler"),
        NO_COLOR: "1",
        CI: "1",
        GIT_OPTIONAL_LOCKS: "0",
        GIT_NO_LAZY_FETCH: "1",
        ...locators,
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

function expectPreflight(result: Awaited<ReturnType<typeof cli>>, message: string): void {
  expect(result.exitCode).toBe(2);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain(`deploy failed during preflight: ${message}`);
  expect(result.stderr).toContain("No target was touched.");
  expect(result.stderr).not.toContain("deploy refused:");
}

describe("dedicated held post94 CLI status", () => {
  test("0098 stays outside generic schema waves", () => {
    expect(SCHEMA_WAVE_BOUNDARIES.map(String)).not.toContain("0098");
    expect(SCHEMA_WAVE_BOUNDARIES.map(String)).toContain("0093");
    expect(SCHEMA_WAVE_BOUNDARIES.map(String)).toContain("0094");
  });

  test("actual CLI reaches custody refusal before target loading", async () => {
    expectPreflight(
      await cli(["takoserver-d1-schema", ...flags]),
      "money held post94 status requires original-create custody",
    );
  });

  for (let index = 0; index < locatorNames.length; index++) {
    const missing = locatorNames[index];
    test(`missing ${missing} refuses before opening original custody`, async () => {
      const supplied: Record<string, string> = { [originalLocator]: absentPath };
      for (const name of locatorNames.slice(0, index)) supplied[name] = absentPath;
      expectPreflight(
        await cli(["takoserver-d1-schema", ...flags], supplied),
        `${missing} is required and must not have outer whitespace`,
      );
    });
  }

  for (const invalid of [originalLocator, ...locatorNames]) {
    test(`noncanonical ${invalid} refuses before opening original custody`, async () => {
      const supplied = Object.fromEntries(
        [originalLocator, ...locatorNames].map((name) => [name, absentPath]),
      );
      supplied[invalid] = "relative.json";
      expectPreflight(
        await cli(["takoserver-d1-schema", ...flags], supplied),
        invalid === originalLocator
          ? "money held post94 status requires a canonical original-create custody path"
          : `${invalid} must be a canonical absolute protected path`,
      );
    });
  }

  test("apply cannot use status preparation to dispatch without Financial contribution", async () => {
    expectPreflight(
      await cli(
        ["takoserver-d1-schema", ...flags.map((flag) => (flag === "--status" ? "--apply" : flag))],
        { [originalLocator]: absentPath },
      ),
      "money held post94 apply requires the real Financial contribution",
    );
  });

  for (const environment of ["production", "rehearsal"]) {
    test(`0098 refuses ${environment} at parsing`, async () => {
      const result = await cli([
        "takoserver-d1-schema",
        ...flags.map((flag) =>
          flag === "--environment=integration" ? `--environment=${environment}` : flag,
        ),
      ]);
      expect(result.exitCode).toBe(2);
      expect(result.stdout).toBe("");
      expect(result.stderr).toStartWith("deploy refused: no target was touched");
    });
  }

  for (const args of [
    ["takoserver-public-worker", ...flags],
    ["takoserver-d1-schema-rehearsal-baseline", ...flags],
    ["takoserver-d1-schema", ...flags, "--through-migration=0094"],
    [
      "takoserver-d1-schema",
      ...flags.map((flag) =>
        flag === "--through-migration=0098" ? "--through-migration=0097" : flag,
      ),
    ],
  ]) {
    test(`unsupported or ambiguous held route refuses: ${args.join(" ")}`, async () => {
      const result = await cli(args);
      expect(result.exitCode).toBe(2);
      expect(result.stdout).toBe("");
      expect(result.stderr).toStartWith("deploy refused: no target was touched");
    });
  }
});

describe("held consumer composition preserves native original origin", () => {
  test("caller shapes and copied/inherited methods cannot reach protected locator reads", async () => {
    let getters = 0;
    const accessor = Object.defineProperty({}, "phase", {
      get() {
        getters++;
        throw new Error("getter invoked");
      },
    });
    const foreign = Object.freeze({
      phase: "convert",
      writerEpoch: "a".repeat(64),
      custody: Object.freeze({
        read() {
          throw new Error("borrowed custody invoked");
        },
      }),
    });
    for (const candidate of [{}, accessor, foreign, { ...foreign }, Object.create(foreign)]) {
      await expect(
        Reflect.apply(readMoneyUnitHeldPost94ConsumerInputs, undefined, [
          candidate,
          absentPath,
          absentPath,
        ]),
      ).rejects.toThrow("money held convert requires unchanged native original owner methods");
    }
    expect(getters).toBe(0);
  });
});
