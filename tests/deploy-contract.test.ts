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
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

const SURFACES = [
  ["takoserver-worker", []],
  ["takoserver-worker-authority-cutover", ["authority"]],
  ["takoserver-site", []],
  ["takoserver-console", []],
  ["takoserver-d1-schema", ["irreversible"]],
  ["takoserver-signing-key-register", ["irreversible", "authority", "published-identity"]],
  ["takoserver-hosted-topology-cutover", ["irreversible", "authority"]],
  ["takoserver-signing-repair", ["authority"]],
  ["takoserver-signing-rotation", ["authority", "published-identity"]],
  ["takoserver-hosted-token-cutover", ["authority"]],
] as const;

describe("Takoserver split deploy entrypoint", () => {
  test("declares truthful split surfaces and no mixed API controller", async () => {
    const probe = await deploy(["--contract"]);
    expect(probe.exitCode).toBe(0);
    expect(probe.stderr).toBe("");
    const contract = JSON.parse(probe.stdout) as {
      kind: string;
      surfaces: {
        surface: string;
        triggers: readonly string[];
        obligations: Record<string, string>;
      }[];
    };
    expect(contract.kind).toBe("takos.deploy-contract@v2");
    expect(contract.surfaces.map(({ surface, triggers }) => [surface, triggers])).toEqual(
      SURFACES.map(([surface, triggers]) => [surface, [...triggers]]),
    );
    expect(contract.surfaces.some(({ surface }) => surface === "takoserver-api")).toBe(false);

    for (const surface of contract.surfaces) {
      expect(surface.obligations).toMatchObject({
        provenance: expect.any(String),
        "post-conditions": expect.any(String),
        reversal: expect.any(String),
        "failure-handling": expect.any(String),
      });
      if (surface.triggers.length > 0) {
        expect(surface.obligations["independent-review"]).toEqual(expect.any(String));
      }
      if (surface.triggers.includes("irreversible")) {
        expect(surface.obligations["pre-mutation-proof"]).toEqual(expect.any(String));
      }
      if (surface.triggers.includes("published-identity")) {
        expect(surface.obligations["no-overwrite"]).toEqual(expect.any(String));
      }
      expect(JSON.stringify(surface)).not.toContain("ledger");
      expect(JSON.stringify(surface)).not.toContain("--plan");
    }
  });

  test("accepts only selector plus one action, exact environment, and exact commit", async () => {
    const sha = "a".repeat(40);
    for (const args of [
      [],
      ["--contract", "extra"],
      ["takoserver-worker"],
      ["takoserver-worker", "--status"],
      ["takoserver-worker", "--status", "--environment=production"],
      ["takoserver-worker", "--status", "--environment=production", `--commit=${sha}`, "extra"],
      ["takoserver-worker", "--plan", "--environment=production", `--commit=${sha}`],
      ["takoserver-api", "--status", "--environment=production", `--commit=${sha}`],
      ["takoserver-worker", "--status", "--environment=staging", `--commit=${sha}`],
      ["takoserver-worker", "--status", "--environment=production", "--commit=HEAD"],
      ["takoserver-worker", "--status", "--apply", "--environment=production", `--commit=${sha}`],
      [
        "takoserver-worker",
        "--status",
        "--environment=production",
        `--commit=${sha}`,
        "--target=.deploy/target.json",
      ],
    ]) {
      const refused = await deploy(args);
      expect(refused.exitCode).toBe(2);
      expect(refused.stdout).toBe("");
      expect(refused.stderr).toContain("no target was touched");
    }
  });

  test("accepts the legacy predecessor selector only for integration authority cutover", async () => {
    const sha = "a".repeat(40);
    const version = "00000000-0000-4000-8000-000000000001";
    const accepted = await deploy([
      "takoserver-worker-authority-cutover",
      "--status",
      "--environment=integration",
      `--commit=${sha}`,
      `--legacy-predecessor-version=${version}`,
    ]);
    expect(accepted.exitCode).toBe(2);
    expect(accepted.stderr).toContain("deploy target descriptor not found");
    expect(accepted.stderr).not.toContain("no target was touched");

    for (const args of [
      [
        "takoserver-worker",
        "--status",
        "--environment=integration",
        `--commit=${sha}`,
        `--legacy-predecessor-version=${version}`,
      ],
      [
        "takoserver-worker-authority-cutover",
        "--status",
        "--environment=rehearsal",
        `--commit=${sha}`,
        `--legacy-predecessor-version=${version}`,
      ],
      [
        "takoserver-worker-authority-cutover",
        "--status",
        "--environment=production",
        `--commit=${sha}`,
        `--legacy-predecessor-version=${version}`,
      ],
      [
        "takoserver-worker-authority-cutover",
        "--status",
        "--environment=integration",
        `--commit=${sha}`,
        "--legacy-predecessor-version=not-a-version-id",
      ],
      [
        "takoserver-worker-authority-cutover",
        "--status",
        "--environment=integration",
        `--commit=${sha}`,
        `--legacy-predecessor-version=${version}`,
        `--legacy-predecessor-version=${version}`,
      ],
    ] as const) {
      const refused = await deploy(args);
      expect(refused.exitCode).toBe(2);
      expect(refused.stdout).toBe("");
      expect(refused.stderr).toContain("no target was touched");
    }
  });
});
