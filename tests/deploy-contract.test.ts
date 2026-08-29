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
  ["takoserver-form-authority-worker", ["authority"]],
  ["takoserver-integration-form-authority-worker", ["authority"]],
  ["takoserver-integration-form-authority-operator-worker", ["authority"]],
  ["takoserver-integration-form-authority", ["authority"]],
  ["takoserver-site", []],
  ["takoserver-console", []],
  ["takoserver-d1-schema", ["irreversible"]],
  ["takoserver-signing-key-register", ["irreversible", "authority", "published-identity"]],
  ["takoserver-signing-repair", ["authority"]],
  ["takoserver-signing-rotation", ["authority", "published-identity"]],
  ["takoserver-hosted-token-cutover", ["authority"]],
  ["takoserver-host-runtime-topology-retirement", ["irreversible", "authority"]],
  ["takoserver-hosted-token-retirement", ["irreversible", "authority"]],
  ["takoserver-integration-operator-identity", ["authority"]],
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

    const integrationAuthority = contract.surfaces.find(
      ({ surface }) => surface === "takoserver-integration-form-authority-worker",
    );
    const gateway = contract.surfaces.find(
      ({ surface }) => surface === "takoserver-integration-form-authority-operator-worker",
    );
    const invocation = contract.surfaces.find(
      ({ surface }) => surface === "takoserver-integration-form-authority",
    );
    expect(integrationAuthority?.obligations["post-conditions"]).toContain(
      "exact operator tenant and Space plain-text bindings",
    );
    expect(integrationAuthority?.obligations["failure-handling"]).toContain(
      "outside its sealed tenant/Space",
    );
    expect(gateway?.obligations["post-conditions"]).toContain(
      "only when both the script and configured custom domain are absent",
    );
    expect(gateway?.obligations["failure-handling"]).toContain("script/domain partial topology");
    expect(invocation?.obligations["failure-handling"]).toContain(
      "exits as a verification failure",
    );

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
      [
        "takoserver-host-runtime-topology-retirement",
        "--status",
        "--environment=integration",
        `--commit=${sha}`,
      ],
      [
        "takoserver-hosted-token-retirement",
        "--status",
        "--environment=integration",
        `--commit=${sha}`,
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

  test("accepts the reviewed Hosted-edge retirement selector only on retirement surfaces", async () => {
    const sha = "a".repeat(40);
    const version = "00000000-0000-4000-8000-000000000001";
    for (const surface of [
      "takoserver-worker-authority-cutover",
      "takoserver-host-runtime-topology-retirement",
      "takoserver-hosted-token-retirement",
    ] as const) {
      for (const environment of ["integration", "production"] as const) {
        const accepted = await deploy([
          surface,
          "--status",
          `--environment=${environment}`,
          `--commit=${sha}`,
          `--legacy-host-runtime-predecessor-version=${version}`,
        ]);
        expect(accepted.exitCode).toBe(2);
        expect(accepted.stderr).toContain("deploy target descriptor not found");
        expect(accepted.stderr).not.toContain("no target was touched");
      }
    }

    for (const args of [
      [
        "takoserver-worker-authority-cutover",
        "--status",
        "--environment=integration",
        `--commit=${sha}`,
        `--legacy-host-runtime-predecessor-version=${version}`,
        "--reverse",
      ],
      [
        "takoserver-host-runtime-topology-retirement",
        "--status",
        "--environment=integration",
        `--commit=${sha}`,
        "--reverse",
      ],
      [
        "takoserver-worker-authority-cutover",
        "--apply",
        "--environment=integration",
        `--commit=${sha}`,
        "--reverse",
      ],
      [
        "takoserver-worker",
        "--status",
        "--environment=integration",
        `--commit=${sha}`,
        `--legacy-host-runtime-predecessor-version=${version}`,
      ],
      [
        "takoserver-hosted-token-cutover",
        "--status",
        "--environment=integration",
        `--commit=${sha}`,
        `--legacy-host-runtime-predecessor-version=${version}`,
      ],
      [
        "takoserver-host-runtime-topology-retirement",
        "--status",
        "--environment=rehearsal",
        `--commit=${sha}`,
        `--legacy-host-runtime-predecessor-version=${version}`,
      ],
      [
        "takoserver-hosted-token-retirement",
        "--status",
        "--environment=rehearsal",
        `--commit=${sha}`,
        `--legacy-host-runtime-predecessor-version=${version}`,
      ],
    ] as const) {
      const refused = await deploy(args);
      expect(refused.exitCode).toBe(2);
      expect(refused.stdout).toBe("");
      expect(refused.stderr).toContain("no target was touched");
    }
  });

  test("parses the operator identity surface only for integration", async () => {
    const sha = "a".repeat(40);
    const accepted = await deploy([
      "takoserver-integration-operator-identity",
      "--status",
      "--environment=integration",
      `--commit=${sha}`,
    ]);
    expect(accepted.exitCode).toBe(2);
    expect(accepted.stderr).toContain("deploy target descriptor not found");
    expect(accepted.stderr).not.toContain("no target was touched");

    for (const environment of ["rehearsal", "production"] as const) {
      const refused = await deploy([
        "takoserver-integration-operator-identity",
        "--status",
        `--environment=${environment}`,
        `--commit=${sha}`,
      ]);
      expect(refused.exitCode).toBe(2);
      expect(refused.stdout).toBe("");
      expect(refused.stderr).toContain("no target was touched");
      expect(refused.stderr).not.toContain("deploy target descriptor");
    }
  });

  test("parses the fixture Form authority surface only for integration", async () => {
    const sha = "a".repeat(40);
    const accepted = await deploy([
      "takoserver-integration-form-authority-worker",
      "--status",
      "--environment=integration",
      `--commit=${sha}`,
    ]);
    expect(accepted.exitCode).toBe(2);
    expect(accepted.stderr).toContain("deploy target descriptor not found");
    expect(accepted.stderr).not.toContain("no target was touched");

    for (const environment of ["rehearsal", "production"] as const) {
      const refused = await deploy([
        "takoserver-integration-form-authority-worker",
        "--status",
        `--environment=${environment}`,
        `--commit=${sha}`,
      ]);
      expect(refused.exitCode).toBe(2);
      expect(refused.stdout).toBe("");
      expect(refused.stderr).toContain("no target was touched");
      expect(refused.stderr).not.toContain("deploy target descriptor");
    }
  });

  test("parses the authenticated Form authority operator gateway only for integration", async () => {
    const sha = "a".repeat(40);
    const accepted = await deploy([
      "takoserver-integration-form-authority-operator-worker",
      "--status",
      "--environment=integration",
      `--commit=${sha}`,
    ]);
    expect(accepted.exitCode).toBe(2);
    expect(accepted.stderr).toContain("deploy target descriptor not found");
    expect(accepted.stderr).not.toContain("no target was touched");

    for (const environment of ["rehearsal", "production"] as const) {
      const refused = await deploy([
        "takoserver-integration-form-authority-operator-worker",
        "--status",
        `--environment=${environment}`,
        `--commit=${sha}`,
      ]);
      expect(refused.exitCode).toBe(2);
      expect(refused.stdout).toBe("");
      expect(refused.stderr).toContain("no target was touched");
      expect(refused.stderr).not.toContain("deploy target descriptor");
    }
  });

  test("parses the signed Form authority invocation only for integration", async () => {
    const sha = "a".repeat(40);
    const accepted = await deploy([
      "takoserver-integration-form-authority",
      "--status",
      "--environment=integration",
      `--commit=${sha}`,
    ]);
    expect(accepted.exitCode).toBe(2);
    expect(accepted.stderr).toContain("deploy target descriptor not found");
    expect(accepted.stderr).not.toContain("no target was touched");

    for (const environment of ["rehearsal", "production"] as const) {
      const refused = await deploy([
        "takoserver-integration-form-authority",
        "--status",
        `--environment=${environment}`,
        `--commit=${sha}`,
      ]);
      expect(refused.exitCode).toBe(2);
      expect(refused.stdout).toBe("");
      expect(refused.stderr).toContain("no target was touched");
      expect(refused.stderr).not.toContain("deploy target descriptor");
    }
  });
});
