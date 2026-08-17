import { describe, expect, test } from "bun:test";

describe("Takoserver deploy entrypoint", () => {
  test("reports an authority-triggered contract without performing a live deploy", async () => {
    const probe = Bun.spawn(["bun", "run", "--silent", "deploy", "--", "--contract"], {
      cwd: `${import.meta.dir}/..`,
      stdout: "pipe",
      stderr: "pipe",
    });
    const contract = await new Response(probe.stdout).json();
    expect(await probe.exited).toBe(0);
    expect(contract).toMatchObject({
      kind: "takos.deploy-contract@v2",
      surfaces: [
        {
          surface: "takoserver-api",
          target: "cloudflare-worker:takoserver-api",
          covers: expect.arrayContaining(["wrangler.jsonc", "migrations", "src/worker.ts"]),
          requiresScripts: ["check", "deploy"],
          requiresTools: ["bun", "wrangler"],
          requiresEnv: [],
          triggers: ["published-identity", "authority", "irreversible"],
          obligations: {
            provenance: expect.any(String),
            "post-conditions": expect.any(String),
            reversal: expect.any(String),
            "failure-handling": expect.any(String),
            "no-overwrite": expect.any(String),
            "pre-mutation-proof": expect.any(String),
            "independent-review": expect.any(String),
          },
        },
      ],
    });

    const refused = Bun.spawn(["bun", "run", "--silent", "deploy"], {
      cwd: `${import.meta.dir}/..`,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await refused.exited).not.toBe(0);
    expect(await new Response(refused.stderr).text()).toContain("live deploy is not implemented");

    const mixed = Bun.spawn(
      ["bun", "run", "--silent", "deploy", "--", "--contract", "takoserver-api"],
      {
        cwd: `${import.meta.dir}/..`,
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expect(await mixed.exited).not.toBe(0);
    expect(await new Response(mixed.stdout).text()).toBe("");
  });
});
