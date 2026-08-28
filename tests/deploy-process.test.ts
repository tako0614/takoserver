import { afterEach, describe, expect, test } from "bun:test";
import { runCommand } from "../scripts/deploy/process.ts";

const AMBIENT = "TAKOSERVER_TEST_AMBIENT_SECRET";
const previous = process.env[AMBIENT];

afterEach(() => {
  if (previous === undefined) delete process.env[AMBIENT];
  else process.env[AMBIENT] = previous;
});

describe("sanitized deploy child environment", () => {
  test("passes only the process substrate and explicit per-command authority", async () => {
    process.env[AMBIENT] = "must-not-cross";
    const result = await runCommand(
      [
        "bun",
        "-e",
        "console.log(JSON.stringify({ ambient: process.env.TAKOSERVER_TEST_AMBIENT_SECRET ?? null, token: process.env.CLOUDFLARE_API_TOKEN ?? null, path: typeof process.env.PATH }))",
      ],
      { env: { CLOUDFLARE_API_TOKEN: "explicit-token" } },
    );
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      ambient: null,
      token: "explicit-token",
      path: "string",
    });
  });

  test("does not mutate the parent environment", async () => {
    delete process.env[AMBIENT];
    await runCommand(["bun", "-e", "process.exit(0)"], {
      env: { [AMBIENT]: "child-only" },
    });
    expect(process.env[AMBIENT]).toBeUndefined();
  });
});
