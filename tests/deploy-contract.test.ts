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
    const apiSurface = contract.surfaces[0] as { obligations: Record<string, string> } | undefined;
    if (!apiSurface) throw new Error("Takoserver API deploy surface is missing");
    const failureHandling = apiSurface.obligations["failure-handling"];
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
    expect(failureHandling?.includes("--status")).toBe(true);
    expect(failureHandling?.includes("binding closure")).toBe(true);
    expect(contract.surfaces.map((surface) => surface.surface)).toEqual([
      "takoserver-api",
      "takoserver-console",
      "takoserver-site",
    ]);
    const siteSurface = contract.surfaces.find(
      (surface) => surface.surface === "takoserver-site",
    ) as
      | {
          target?: string;
          covers?: readonly string[];
          requiresScripts?: readonly string[];
          requiresEnv?: readonly string[];
          triggers?: readonly string[];
          obligations?: Record<string, string>;
        }
      | undefined;
    expect(siteSurface).toBeDefined();
    expect(siteSurface?.target).toBe("cloudflare-pages:takoserver-website");
    expect(siteSurface?.covers).toEqual(
      expect.arrayContaining([
        "src/landing.ts",
        "scripts/build-site.ts",
        "scripts/deploy/static.ts",
        "package.json",
      ]),
    );
    expect(siteSurface?.covers).not.toContain("scripts/deploy/web.ts");
    expect(siteSurface?.requiresScripts).toEqual(["build:site", "deploy"]);
    expect(siteSurface?.requiresEnv).toEqual([]);
    expect(siteSurface?.triggers).toEqual([]);
    expect(siteSurface?.obligations?.provenance).toContain("dirty non-main branch");
    expect(siteSurface?.obligations?.provenance).toContain("origin/main");
    expect(siteSurface?.obligations?.["post-conditions"]).toContain(
      "immutable Pages deployment URL",
    );
    expect(siteSurface?.obligations?.["post-conditions"]).toContain("takoserver.com");
    expect(siteSurface?.obligations?.reversal).toContain("Pages deployment history");
    expect(siteSurface?.obligations?.["failure-handling"]).toContain("indeterminate");
    expect(JSON.stringify(siteSurface)).not.toContain("CLOUDFLARE_API_TOKEN");
  });

  test("refuses every invocation that does not name an explicit action", async () => {
    for (const args of [
      [],
      ["--contract", "takoserver-api"],
      ["--apply", "--plan"],
      ["--nope"],
      ["console"],
      ["console", "site", "--plan"],
      ["site"],
      ["site", "--status"],
      ["site", "--plan"],
      ["site", "--apply"],
    ]) {
      const refused = await deploy(args);
      expect(refused.exitCode).toBe(2);
      expect(refused.stdout).toBe("");
      expect(refused.stderr).toMatch(/target was touched/i);
      if (args[0] === "site") expect(refused.stderr).not.toContain("--status");
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
