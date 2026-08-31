import { afterEach, describe, expect, test } from "bun:test";
import { cloudflareChildEnvironment, runCommand } from "../scripts/deploy/process.ts";

const AMBIENT = "TAKOSERVER_TEST_AMBIENT_SECRET";
const BUILDER_INPUT = "TAKOSERVER_BUILDX_BUILDER";
const previous = Object.fromEntries(
  [AMBIENT, BUILDER_INPUT, "BUILDX_BUILDER", "CLOUDFLARE_API_TOKEN"].map((name) => [
    name,
    process.env[name],
  ]),
);

afterEach(() => {
  for (const [name, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
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

  test("maps only the validated Takoserver buildx selector", async () => {
    process.env.CLOUDFLARE_API_TOKEN = "explicit-token";
    process.env.BUILDX_BUILDER = "ambient-must-not-cross";
    delete process.env[BUILDER_INPUT];

    const absent = await runCommand(
      ["bun", "-e", "console.log(process.env.BUILDX_BUILDER ?? 'absent')"],
      { env: cloudflareChildEnvironment() },
    );
    expect(absent.exitCode).toBe(0);
    expect(absent.stdout.trim()).toBe("absent");

    process.env[BUILDER_INPUT] = "remote_builder-1.example";
    const selected = await runCommand(
      ["bun", "-e", "console.log(process.env.BUILDX_BUILDER ?? 'absent')"],
      { env: cloudflareChildEnvironment() },
    );
    expect(selected.exitCode).toBe(0);
    expect(selected.stdout.trim()).toBe("remote_builder-1.example");
  });

  test("rejects executable paths and malformed buildx selectors before a child runs", () => {
    process.env.CLOUDFLARE_API_TOKEN = "explicit-token";
    for (const value of ["/tmp/docker-wrapper", "tcp://builder", " leading", "", "x".repeat(129)]) {
      process.env[BUILDER_INPUT] = value;
      expect(() => cloudflareChildEnvironment()).toThrow(BUILDER_INPUT);
    }
  });
});
