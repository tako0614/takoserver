import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { realizeTargetAfterGate } from "../scripts/deploy/preflight.ts";
import { writeRealizedConfig } from "../scripts/deploy/realized-config.ts";
import { assertOfficialApiTarget, type DeployTarget } from "../scripts/deploy/target.ts";

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
      "takoserver-api-staging",
      "takoserver-console",
      "takoserver-site",
    ]);
    expect(contract.surfaces[1]).toMatchObject({
      surface: "takoserver-api-staging",
      target: "cloudflare-worker:takoserver-api-staging",
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
    const siteSurface = contract.surfaces.find(
      (surface) => surface.surface === "takoserver-site",
    ) as
      | {
          requiresEnv?: readonly string[];
          obligations?: Record<string, string>;
        }
      | undefined;
    expect(siteSurface).toBeDefined();
    expect(siteSurface?.requiresEnv).toEqual([]);
    expect(siteSurface?.obligations?.provenance).toContain("Wrangler-managed authentication");
    expect(siteSurface?.obligations?.provenance).toContain("account identity");
    expect(siteSurface?.obligations?.["post-conditions"]).toContain("exact zone route");
    expect(siteSurface?.obligations?.reversal).toContain("restore no owner");
    expect(siteSurface?.obligations?.reversal).toContain("reattach");
    expect(siteSurface?.obligations?.["pre-mutation-proof"]).toContain("account-scoped");
    expect(JSON.stringify(siteSurface)).not.toContain("CLOUDFLARE_API_TOKEN");
  });

  test("refuses every invocation that does not name an explicit action", async () => {
    for (const args of [
      [],
      ["--contract", "takoserver-api"],
      ["--apply", "--plan"],
      ["--nope"],
      ["console"],
      ["staging"],
      ["console", "site", "--plan"],
    ]) {
      const refused = await deploy(args);
      expect(refused.exitCode).toBe(2);
      expect(refused.stdout).toBe("");
      expect(refused.stderr).toContain("no target was touched");
    }
  });

  test("staging cannot point at the production Worker or durable stores", async () => {
    const production = {
      accountId: "0".repeat(32),
      workerName: "takoserver-api",
      d1: {
        databaseName: "takoserver-runtime",
        databaseId: "00000000-0000-0000-0000-000000000000",
      },
      r2: { bucketName: "takoserver-objects" },
      publicOrigin: "https://api.takoserver.test",
      grantKeyId: "takoserver-runtime-test",
    } satisfies DeployTarget;
    expect(() => assertOfficialApiTarget("staging", production)).toThrow(
      "requires physically separate staging resources",
    );
    expect(() => assertOfficialApiTarget("production", production)).not.toThrow();

    const staging = {
      ...production,
      workerName: "takoserver-api-staging",
      d1: {
        ...production.d1,
        databaseName: "takoserver-runtime-staging",
      },
      r2: { bucketName: "takoserver-objects-staging" },
    } satisfies DeployTarget;
    expect(() => assertOfficialApiTarget("staging", staging)).not.toThrow();
    expect(() => assertOfficialApiTarget("production", staging)).toThrow(
      "production surface requires workerName takoserver-api",
    );

    const realizedPath = writeRealizedConfig(staging);
    const realized = JSON.parse(readFileSync(realizedPath, "utf8")) as {
      readonly name?: string;
    };
    expect(realized.name).toBe("takoserver-api-staging");

    const postGatePath = await realizeTargetAfterGate(staging, async () => {
      writeRealizedConfig(production);
    });
    const postGate = JSON.parse(readFileSync(postGatePath, "utf8")) as {
      readonly name?: string;
      readonly account_id?: string;
    };
    expect(postGate).toMatchObject({
      name: "takoserver-api-staging",
      account_id: staging.accountId,
    });
  });

  test("refuses before Cloudflare when the deploy target descriptor is absent", async () => {
    const missing = await deploy(["--apply", "--target", "tests/fixtures/absent-target.json"]);
    expect(missing.exitCode).toBe(2);
    expect(missing.stdout).toBe("");
    expect(missing.stderr).toContain("deploy target descriptor not found");
    expect(missing.stderr).toContain("No Cloudflare target was touched");
  });
});
