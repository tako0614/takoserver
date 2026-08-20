import { describe, expect, test } from "bun:test";

const REPOSITORY = `${import.meta.dir}/..`;

async function deploy(args: readonly string[]): Promise<{
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}> {
  const child = Bun.spawn(["bun", "run", "--silent", "deploy", "--", ...args], {
    cwd: REPOSITORY,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

describe("Takoserver deploy entrypoint", () => {
  test("reports an authority-triggered contract without touching a target", async () => {
    const probe = await deploy(["--contract"]);
    expect(probe.exitCode).toBe(0);
    const contract = JSON.parse(probe.stdout) as {
      kind: string;
      surfaces: { surface: string; [key: string]: unknown }[];
    };
    expect(contract.kind).toBe("takos.deploy-contract@v2");
    expect(contract.surfaces[0]).toMatchObject({
      surface: "takoserver-api",
      target: "cloudflare-worker:takoserver-api",
      covers: expect.arrayContaining(["wrangler.jsonc", "migrations", "src/entry-worker.ts"]),
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
    });
    expect(contract.surfaces.map((surface) => surface.surface)).toEqual([
      "takoserver-api",
      "takoserver-console",
      "takoserver-site",
    ]);
  });

  test("refuses every invocation that does not name an explicit action", async () => {
    for (const args of [
      [],
      ["--contract", "takoserver-api"],
      ["--apply", "--plan"],
      ["--nope"],
      ["console"],
      ["console", "site", "--plan"],
    ]) {
      const refused = await deploy(args);
      expect(refused.exitCode).toBe(2);
      expect(refused.stdout).toBe("");
      expect(refused.stderr).toContain("no target was touched");
    }
  });

  test("refuses before Cloudflare when the deploy target descriptor is absent", async () => {
    const missing = await deploy(["--apply", "--target", "tests/fixtures/absent-target.json"]);
    expect(missing.exitCode).toBe(2);
    expect(missing.stdout).toBe("");
    expect(missing.stderr).toContain("deploy target descriptor not found");
    expect(missing.stderr).toContain("No Cloudflare target was touched");
  });
});
