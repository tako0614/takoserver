import { afterEach, describe, expect, spyOn, test } from "bun:test";

// takos-secret-scan: synthetic
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createDeployProcess,
  type DeployProcessStage,
  parseWranglerAuthToken,
  REPOSITORY,
  resolveCloudflareCredential,
  runCommand,
} from "../scripts/deploy/process.ts";
import { wranglerPathForTests } from "./helpers/wrangler-path.ts";

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

describe("integration Cloudflare credential resolver", () => {
  test("accepts only the exact OAuth object and keeps malformed values value-free", () => {
    const secret = "oauth-secret-never-in-an-error";
    expect(parseWranglerAuthToken(JSON.stringify({ type: "oauth", token: secret }))).toBe(secret);
    for (const raw of [
      "",
      "not-json",
      JSON.stringify({ type: "api-token", token: secret }),
      JSON.stringify({ type: "oauth", token: 42 }),
      JSON.stringify({ type: "oauth", token: secret, extra: true }),
      JSON.stringify({ type: "oauth", token: " " }),
      JSON.stringify({ type: "oauth", token: `bad\n${secret}` }),
    ]) {
      expect(() => parseWranglerAuthToken(raw)).toThrow(
        "Wrangler OAuth token response is malformed",
      );
      try {
        parseWranglerAuthToken(raw);
      } catch (error) {
        expect(String(error)).not.toContain(secret);
      }
    }
  });

  test("explicit API tokens win without invoking Wrangler", async () => {
    const explicit = "explicit-api-token";
    const sentinels = [
      "api-key-must-not-cross",
      "email-must-not-cross@example.test",
      "legacy-token-must-not-cross",
      "legacy-api-key-must-not-cross",
      "legacy-email-must-not-cross@example.test",
      "auth-token-must-not-cross",
      "unrelated-secret-must-not-cross",
    ];
    let calls = 0;
    const credential = await resolveCloudflareCredential("integration", {
      cloudflareEnvironment: {
        CLOUDFLARE_API_TOKEN: explicit,
        CLOUDFLARE_API_KEY: sentinels[0] as string,
        CLOUDFLARE_EMAIL: sentinels[1] as string,
        CF_API_TOKEN: sentinels[2] as string,
        CF_API_KEY: sentinels[3] as string,
        CF_EMAIL: sentinels[4] as string,
        CLOUDFLARE_AUTH_TOKEN: sentinels[5] as string,
        TAKOSERVER_UNRELATED_SECRET: sentinels[6] as string,
      },
      run: async () => {
        calls += 1;
        return { exitCode: 0, stdout: "{}", stderr: "" };
      },
    });
    expect(calls).toBe(0);
    expect(credential).toEqual({
      token: explicit,
      childEnvironment: { CLOUDFLARE_API_TOKEN: explicit },
      source: "api-token",
    });
    const serialized = JSON.stringify(credential.childEnvironment);
    for (const sentinel of sentinels) expect(serialized).not.toContain(sentinel);
  });

  test("integration consumes Wrangler OAuth once and never passes its bearer to children", async () => {
    const secret = "oauth-token-only-in-process";
    const privateWrangler = "/private-composition/node_modules/.bin/wrangler";
    const calls: { command: readonly string[]; env: Readonly<Record<string, string>> }[] = [];
    const credential = await resolveCloudflareCredential("integration", {
      cloudflareEnvironment: {},
      wranglerPath: privateWrangler,
      run: async (command, options) => {
        calls.push({ command, env: options?.env ?? {} });
        return {
          exitCode: 0,
          stdout: JSON.stringify({ type: "oauth", token: secret }),
          stderr: "",
        };
      },
    });
    expect(credential.token).toBe(secret);
    expect(credential.source).toBe("oauth");
    expect(credential.childEnvironment).toEqual({
      WRANGLER_WRITE_LOGS: "false",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.command[0]).toBe(privateWrangler);
    expect(calls[0]?.command.slice(-3)).toEqual(["auth", "token", "--json"]);
    expect(calls[0]?.env).toEqual({
      WRANGLER_WRITE_LOGS: "false",
    });
    expect(JSON.stringify(calls[0])).not.toContain(secret);
  });

  test("OAuth child environments allowlist Wrangler behavior and strip competing credentials", async () => {
    const sentinels = {
      apiKey: "api-key-must-not-cross",
      email: "email-must-not-cross@example.test",
      legacyToken: "legacy-token-must-not-cross",
      legacyApiKey: "legacy-api-key-must-not-cross",
      legacyEmail: "legacy-email-must-not-cross@example.test",
      authToken: "auth-token-must-not-cross",
      unrelated: "unrelated-secret-must-not-cross",
    };
    const credential = await resolveCloudflareCredential("integration", {
      cloudflareEnvironment: {
        CLOUDFLARE_API_KEY: sentinels.apiKey,
        CLOUDFLARE_EMAIL: sentinels.email,
        CF_API_TOKEN: sentinels.legacyToken,
        CF_API_KEY: sentinels.legacyApiKey,
        CF_EMAIL: sentinels.legacyEmail,
        CLOUDFLARE_AUTH_TOKEN: sentinels.authToken,
        TAKOSERVER_UNRELATED_SECRET: sentinels.unrelated,
      },
      run: async () => ({
        exitCode: 0,
        stdout: JSON.stringify({ type: "oauth", token: "oauth-only-child-allowlist" }),
        stderr: "",
      }),
    });
    expect(credential.childEnvironment).toEqual({
      WRANGLER_WRITE_LOGS: "false",
    });
    const serialized = JSON.stringify(credential.childEnvironment);
    for (const sentinel of Object.values(sentinels)) expect(serialized).not.toContain(sentinel);
  });

  test("real Wrangler OAuth extraction leaves no sentinel in debug or ambient files", async () => {
    const root = join(tmpdir(), `takoserver-oauth-subprocess-${Date.now()}-${Math.random()}`);
    const home = join(root, "home");
    const config = join(root, "xdg-config");
    const cache = join(root, "xdg-cache");
    const logs = join(root, "logs");
    const credentialPath = join(config, ".wrangler", "config", "default.toml");
    mkdirSync(home, { recursive: true, mode: 0o700 });
    mkdirSync(join(config, ".wrangler", "config"), { recursive: true, mode: 0o700 });
    mkdirSync(cache, { recursive: true, mode: 0o700 });
    mkdirSync(logs, { recursive: true, mode: 0o700 });
    const secret = `oauth-subprocess-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    try {
      writeFileSync(
        credentialPath,
        `oauth_token = "${secret}"\nexpiration_time = "2099-01-01T00:00:00.000Z"\n`,
        { mode: 0o600 },
      );
      const credential = await resolveCloudflareCredential("integration", {
        cloudflareEnvironment: {},
        wranglerPath: wranglerPathForTests(),
        run: async (command, options = {}) =>
          await runCommand(command, {
            ...options,
            env: {
              ...options.env,
              HOME: home,
              XDG_CONFIG_HOME: config,
              XDG_CACHE_HOME: cache,
              WRANGLER_LOG_PATH: logs,
            },
          }),
      });
      expect(credential.source).toBe("oauth");
      expect(credential.token).toBe(secret);
      expect(credential.childEnvironment).toEqual({
        WRANGLER_WRITE_LOGS: "false",
      });
      expect(readdirSync(logs)).toEqual([]);
      const leakedFiles = [
        ...findFilesContaining(root, secret),
        ...findFilesContaining(REPOSITORY, secret),
      ].filter((path) => path !== credentialPath);
      expect(leakedFiles).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rehearsal and production reject an absent explicit token", async () => {
    for (const environment of ["rehearsal", "production"] as const) {
      let calls = 0;
      await expect(
        resolveCloudflareCredential(environment, {
          cloudflareEnvironment: {},
          run: async () => {
            calls += 1;
            return { exitCode: 0, stdout: "{}", stderr: "" };
          },
        }),
      ).rejects.toThrow("CLOUDFLARE_API_TOKEN is required");
      expect(calls).toBe(0);
    }
  });

  test("does not expose OAuth command output on failure", async () => {
    const secret = "oauth-secret-in-diagnostics";
    const commandFailure = await resolveCloudflareCredential("integration", {
      cloudflareEnvironment: {},
      run: async () => ({ exitCode: 1, stdout: secret, stderr: secret }),
    }).catch((error: unknown) => error);
    expect(String(commandFailure)).not.toContain(secret);
    const shapeFailure = await resolveCloudflareCredential("integration", {
      cloudflareEnvironment: {},
      run: async () => ({
        exitCode: 0,
        stdout: JSON.stringify({ type: "oauth", token: secret, extra: true }),
        stderr: "",
      }),
    }).catch((error: unknown) => error);
    expect(String(shapeFailure)).not.toContain(secret);
  });
});

function findFilesContaining(root: string, secret: string): string[] {
  const files: string[] = [];
  const visit = (path: string): void => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === ".git" || entry.name === "node_modules") continue;
        visit(child);
      } else if (entry.isFile() && readFileSync(child).includes(secret)) {
        files.push(child);
      }
    }
  };
  visit(root);
  return files;
}

describe("opt-in deploy process stage observations", () => {
  test("observes completion facts without command, input, environment or output values", async () => {
    const events: DeployProcessStage[] = [];
    const sentinel = "synthetic-stage-payload-must-not-cross";
    const context = createDeployProcess({
      repositoryRoot: REPOSITORY,
      onStage: (event) => {
        events.push(event);
      },
    });
    const result = await context.run(
      [
        "bun",
        "-e",
        "console.log(await new Response(Bun.stdin.stream()).text()); console.error(process.env.PROCESS_STAGE_SENTINEL);",
      ],
      { input: sentinel, env: { PROCESS_STAGE_SENTINEL: sentinel } },
    );
    expect(result).toEqual({ exitCode: 0, stdout: `${sentinel}\n`, stderr: `${sentinel}\n` });
    expect(events.map((event) => event.stage).slice(0, 3)).toEqual([
      "spawn-started",
      "spawned",
      "input-ended",
    ]);
    expect(
      events
        .map((event) => event.stage)
        .slice(3, -1)
        .sort(),
    ).toEqual(["child-exited", "stderr-eof", "stdout-eof"]);
    expect(events.at(-1)?.stage).toBe("complete");
    expect(events.every((event) => Object.isFrozen(event))).toBe(true);
    expect(events.every((event) => Number.isFinite(event.elapsedMs) && event.elapsedMs >= 0)).toBe(
      true,
    );
    expect(events.every((event) => Object.keys(event).join(",") === "stage,elapsedMs")).toBe(true);
    expect(JSON.stringify(events)).not.toContain(sentinel);
  });

  test("observer mutation cannot change the original stdin mode or bytes", async () => {
    const original = "original-input-before-observation";
    const replacement = "observer-replacement-must-not-reach-child";
    const options: { input?: string } = { input: original };
    const context = createDeployProcess({
      repositoryRoot: REPOSITORY,
      onStage(event) {
        if (event.stage === "spawn-started") delete options.input;
        if (event.stage === "spawned") options.input = replacement;
      },
    });
    const result = await context.run(
      ["bun", "-e", "console.log(await new Response(Bun.stdin.stream()).text());"],
      options,
    );
    expect(options.input).toBe(replacement);
    expect(result).toEqual({ exitCode: 0, stdout: `${original}\n`, stderr: "" });
  });

  test("a throwing observer cannot interrupt an already spawned child or mask nonzero exit", async () => {
    const stages: string[] = [];
    const context = createDeployProcess({
      repositoryRoot: REPOSITORY,
      onStage: (event) => {
        stages.push(event.stage);
        throw new Error("diagnostic observer failure");
      },
    });
    const result = await context.run([
      "bun",
      "-e",
      "console.log('original stdout'); console.error('original stderr'); process.exit(7);",
    ]);
    expect(result).toEqual({
      exitCode: 7,
      stdout: "original stdout\n",
      stderr: "original stderr\n",
    });
    expect(stages.at(-1)).toBe("complete");
  });

  test("a rejected async observer is contained while the original process completes", async () => {
    const stages: string[] = [];
    const context = createDeployProcess({
      repositoryRoot: REPOSITORY,
      async onStage(event) {
        stages.push(event.stage);
        throw new Error("async diagnostic observer failure");
      },
    });
    expect(await context.run(["bun", "-e", "process.exit(0)"])).toEqual({
      exitCode: 0,
      stdout: "",
      stderr: "",
    });
    expect(stages.at(-1)).toBe("complete");
  });

  test("spawn failure retains its original Error despite a failing observer", async () => {
    const events: DeployProcessStage[] = [];
    const original = new Error("synthetic original spawn failure");
    const spawn = spyOn(Bun, "spawn").mockImplementation(() => {
      throw original;
    });
    try {
      const context = createDeployProcess({
        repositoryRoot: REPOSITORY,
        onStage: (event) => {
          events.push(event);
          throw new Error("observer must not replace spawn failure");
        },
      });
      const failure: unknown = await context
        .run(["/nonexistent/synthetic-stage-private-argument"])
        .catch((error: unknown) => error);
      expect(failure).toBe(original);
      expect(events.map((event) => event.stage)).toEqual(["spawn-started", "spawn-failed"]);
      expect(JSON.stringify(events)).not.toContain("synthetic-stage-private-argument");
      expect(JSON.stringify(events)).not.toContain(original.message);
    } finally {
      spawn.mockRestore();
    }
  });
});
