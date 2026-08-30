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
  ["takoserver-form-authority-identity-probe", ["authority"]],
  ["takoserver-form-authority-worker", ["authority"]],
  ["takoserver-integration-form-authority-worker", ["authority"]],
  ["takoserver-integration-form-authority-operator-worker", ["authority"]],
  ["takoserver-integration-form-authority", ["authority"]],
  ["takoserver-integration-form-authority-deactivation", ["authority"]],
  ["takoserver-integration-e2e-credentials", ["authority"]],
  ["takoserver-site", []],
  ["takoserver-console", []],
  ["takoserver-d1-schema", ["irreversible"]],
  ["takoserver-signing-key-register", ["irreversible", "authority", "published-identity"]],
  ["takoserver-signing-repair", ["authority"]],
  ["takoserver-signing-rotation", ["authority", "published-identity"]],
  ["takoserver-hosted-token-cutover", ["authority"]],
  ["takoserver-host-runtime-topology-retirement", ["irreversible", "authority"]],
  ["takoserver-hosted-token-retirement", ["irreversible", "authority"]],
  ["takoserver-worker-retirement-attribution-repair", []],
  ["takoserver-integration-operator-identity", ["authority"]],
  ["takoserver-integration-legacy-operator-authority-retirement", ["authority"]],
  ["takoserver-integration-legacy-operator-authority-restore", ["authority"]],
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
        requiresEnv: readonly string[];
        requiresTools: readonly string[];
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
    const deactivation = contract.surfaces.find(
      ({ surface }) => surface === "takoserver-integration-form-authority-deactivation",
    );
    const credentials = contract.surfaces.find(
      ({ surface }) => surface === "takoserver-integration-e2e-credentials",
    );
    const hosted = contract.surfaces.find(
      ({ surface }) => surface === "takoserver-hosted-token-cutover",
    );
    const routineWorker = contract.surfaces.find(({ surface }) => surface === "takoserver-worker");
    expect(routineWorker?.requiresTools).toContain("flock");
    expect(routineWorker?.obligations.provenance).toContain("explicit `CLOUDFLARE_API_TOKEN`");
    expect(routineWorker?.obligations.provenance).not.toContain("stored OAuth profile");
    expect(routineWorker?.obligations["post-conditions"]).toContain(
      "one versions upload followed by one explicit 100 percent deployment",
    );
    expect(routineWorker?.obligations["post-conditions"]).toContain(
      "re-read immediately after upload and before traffic deployment",
    );
    expect(routineWorker?.obligations["post-conditions"]).toContain(
      "no conditional deployment/CAS input",
    );
    expect(routineWorker?.obligations["post-conditions"]).toContain("actual immediate predecessor");
    expect(routineWorker?.obligations["post-conditions"]).toContain(
      "exact account-owned workers.dev hostname",
    );
    expect(routineWorker?.obligations["post-conditions"]).toContain("PID-start");
    expect(routineWorker?.obligations["post-conditions"]).toContain("stale");
    expect(routineWorker?.obligations["failure-handling"]).toContain("traffic is indeterminate");
    expect(routineWorker?.obligations["failure-handling"]).toContain(
      "never claims that no target was touched",
    );
    expect(routineWorker?.obligations["failure-handling"]).not.toContain(
      "uploaded Version is inactive",
    );
    expect(routineWorker?.obligations["failure-handling"]).toContain("Wrangler OAuth is refused");
    expect(integrationAuthority?.obligations["post-conditions"]).toContain(
      "exact operator tenant and Space plain-text bindings",
    );
    expect(integrationAuthority?.obligations["failure-handling"]).toContain(
      "outside its sealed tenant/Space",
    );
    expect(integrationAuthority?.obligations["failure-handling"]).toContain("already-target apply");
    expect(integrationAuthority?.obligations["post-conditions"]).toContain(
      "exact-transition-predecessor",
    );
    expect(gateway?.obligations["post-conditions"]).toContain(
      "only when both the script and configured custom domain are absent",
    );
    expect(gateway?.obligations["failure-handling"]).toContain("script/domain partial topology");
    expect(gateway?.obligations["post-conditions"]).toContain(
      "route-less authority must already be exact-target",
    );
    expect(invocation?.obligations["failure-handling"]).toContain(
      "exits as a verification failure",
    );
    expect(invocation?.obligations["failure-handling"]).toContain(
      "never accepts the scope-transition selector",
    );
    expect(deactivation?.obligations["post-conditions"]).toContain(
      "only predecessor desiredActive:false is signed",
    );
    expect(deactivation?.obligations.provenance).toContain("without emitting its path");
    expect(deactivation?.obligations.provenance).toContain("outside every Git worktree");
    expect(deactivation?.obligations["post-conditions"]).toContain("scope-redacted");
    expect(deactivation?.obligations["failure-handling"]).toContain("raw binding JSON");
    expect(credentials?.obligations.provenance).toContain(
      "exact five-variable JIT authority closure",
    );
    expect(credentials?.obligations["failure-handling"]).toContain("never replays issue");
    expect(credentials?.obligations["failure-handling"]).toContain(
      "exact idempotent revoke settlement",
    );
    expect(credentials?.obligations["post-conditions"]).toContain(
      "distinct 3600-second writer and external-evidence secrets",
    );
    expect(credentials?.obligations.reversal).toContain("current dedicated authority");
    expect(hosted?.obligations.provenance).toContain(
      "canonical token-present proof-only apply is available in every environment",
    );
    expect(hosted?.obligations["post-conditions"]).toContain(
      "zero secret, build, dry-run, upload, or configuration mutation",
    );
    expect(hosted?.obligations["post-conditions"]).toContain(
      "functionalProofPending=false, repairRequired=false, and ready=true",
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

  test("mentions every requiresEnv name in that surface's own obligations", async () => {
    const probe = await deploy(["--contract"]);
    expect(probe.exitCode).toBe(0);
    expect(probe.stderr).toBe("");
    const contract = JSON.parse(probe.stdout) as {
      surfaces: {
        surface: string;
        requiresEnv: readonly string[];
        obligations: Record<string, string>;
      }[];
    };

    for (const surface of contract.surfaces) {
      const answers = Object.values(surface.obligations).join("\n");
      const uncovered = surface.requiresEnv.filter((name) => !answers.includes(name));
      expect(uncovered, `${surface.surface} has undiscoverable environment inputs`).toEqual([]);
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
      [
        "takoserver-hosted-token-retirement",
        "--apply",
        "--environment=integration",
        `--commit=${sha}`,
        `--legacy-host-runtime-predecessor-version=${version}`,
        "--reverse",
      ],
    ] as const) {
      const refused = await deploy(args);
      expect(refused.exitCode).toBe(2);
      expect(refused.stdout).toBe("");
      expect(refused.stderr).toContain("no target was touched");
    }
  });

  test("parses attribution repair only with both pinned Versions and no reverse", async () => {
    const sha = "a".repeat(40);
    const legacy = "00000000-0000-4000-8000-000000000001";
    const unattributed = "00000000-0000-4000-8000-000000000004";
    for (const environment of ["integration", "production"] as const) {
      const accepted = await deploy([
        "takoserver-worker-retirement-attribution-repair",
        "--status",
        `--environment=${environment}`,
        `--commit=${sha}`,
        `--legacy-host-runtime-predecessor-version=${legacy}`,
        `--unattributed-successor-version=${unattributed}`,
      ]);
      expect(accepted.exitCode).toBe(2);
      expect(accepted.stderr).toContain("deploy target descriptor not found");
      expect(accepted.stderr).not.toContain("no target was touched");
    }

    for (const args of [
      [
        "takoserver-worker-retirement-attribution-repair",
        "--status",
        "--environment=integration",
        `--commit=${sha}`,
        `--legacy-host-runtime-predecessor-version=${legacy}`,
      ],
      [
        "takoserver-worker-retirement-attribution-repair",
        "--apply",
        "--environment=integration",
        `--commit=${sha}`,
        `--legacy-host-runtime-predecessor-version=${legacy}`,
        `--unattributed-successor-version=${unattributed}`,
        "--reverse",
      ],
      [
        "takoserver-worker-retirement-attribution-repair",
        "--status",
        "--environment=rehearsal",
        `--commit=${sha}`,
        `--legacy-host-runtime-predecessor-version=${legacy}`,
        `--unattributed-successor-version=${unattributed}`,
      ],
      [
        "takoserver-hosted-token-retirement",
        "--status",
        "--environment=integration",
        `--commit=${sha}`,
        `--legacy-host-runtime-predecessor-version=${legacy}`,
        `--unattributed-successor-version=${unattributed}`,
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

  test("pins legacy operator retirement and restore to their own integration surfaces", async () => {
    const sha = "a".repeat(40);
    const version = "00000000-0000-4000-8000-000000000001";
    const selector = `--legacy-operator-authority-predecessor-version=${version}`;
    for (const surface of [
      "takoserver-integration-legacy-operator-authority-retirement",
      "takoserver-integration-legacy-operator-authority-restore",
    ] as const) {
      const accepted = await deploy([
        surface,
        "--status",
        "--environment=integration",
        `--commit=${sha}`,
        selector,
      ]);
      expect(accepted.exitCode).toBe(2);
      expect(accepted.stderr).toContain("deploy target descriptor not found");
      expect(accepted.stderr).not.toContain("no target was touched");
    }

    for (const args of [
      ["takoserver-worker", "--status", "--environment=integration", `--commit=${sha}`, selector],
      [
        "takoserver-worker-authority-cutover",
        "--status",
        "--environment=integration",
        `--commit=${sha}`,
        selector,
      ],
      [
        "takoserver-integration-legacy-operator-authority-retirement",
        "--status",
        "--environment=production",
        `--commit=${sha}`,
        selector,
      ],
      [
        "takoserver-integration-legacy-operator-authority-restore",
        "--status",
        "--environment=rehearsal",
        `--commit=${sha}`,
        selector,
      ],
      [
        "takoserver-integration-legacy-operator-authority-retirement",
        "--status",
        "--environment=integration",
        `--commit=${sha}`,
      ],
      [
        "takoserver-integration-legacy-operator-authority-restore",
        "--status",
        "--environment=integration",
        `--commit=${sha}`,
        "--legacy-operator-authority-predecessor-version=not-a-version",
      ],
    ] as const) {
      const refused = await deploy(args);
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

  test("parses the distinct Form authority deactivation surface only for integration", async () => {
    const sha = "a".repeat(40);
    const accepted = await deploy([
      "takoserver-integration-form-authority-deactivation",
      "--status",
      "--environment=integration",
      `--commit=${sha}`,
    ]);
    expect(accepted.exitCode).toBe(2);
    expect(accepted.stderr).toContain("deploy target descriptor not found");
    expect(accepted.stderr).not.toContain("no target was touched");

    for (const environment of ["rehearsal", "production"] as const) {
      const refused = await deploy([
        "takoserver-integration-form-authority-deactivation",
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

  test("accepts the scope-transition selector only on the two Workers and deactivation", async () => {
    const sha = "a".repeat(40);
    const selector = "--form-authority-scope-transition=/operator/private/transition.json";
    for (const surface of [
      "takoserver-integration-form-authority-worker",
      "takoserver-integration-form-authority-operator-worker",
      "takoserver-integration-form-authority-deactivation",
    ] as const) {
      const accepted = await deploy([
        surface,
        "--status",
        "--environment=integration",
        `--commit=${sha}`,
        selector,
      ]);
      expect(accepted.exitCode).toBe(2);
      expect(accepted.stderr).toContain("deploy target descriptor not found");
      expect(accepted.stderr).not.toContain("no target was touched");
    }

    for (const args of [
      [
        "takoserver-integration-form-authority",
        "--status",
        "--environment=integration",
        `--commit=${sha}`,
        selector,
      ],
      [
        "takoserver-form-authority-worker",
        "--status",
        "--environment=integration",
        `--commit=${sha}`,
        selector,
      ],
      ["takoserver-worker", "--status", "--environment=integration", `--commit=${sha}`, selector],
      [
        "takoserver-integration-form-authority-worker",
        "--status",
        "--environment=production",
        `--commit=${sha}`,
        selector,
      ],
      [
        "takoserver-integration-form-authority-worker",
        "--status",
        "--environment=integration",
        `--commit=${sha}`,
        "--form-authority-scope-transition=relative.json",
      ],
      [
        "takoserver-integration-form-authority-worker",
        "--status",
        "--environment=integration",
        `--commit=${sha}`,
        selector,
        selector,
      ],
      [
        "takoserver-integration-form-authority-worker",
        "--apply",
        "--environment=integration",
        `--commit=${sha}`,
        selector,
        "--reverse",
      ],
    ] as const) {
      const refused = await deploy(args);
      expect(refused.exitCode).toBe(2);
      expect(refused.stdout).toBe("");
      expect(refused.stderr).toContain("no target was touched");
      expect(refused.stderr).not.toContain("deploy target descriptor");
    }
  });

  test("parses the distinct integration credential actions only for integration", async () => {
    const sha = "a".repeat(40);
    for (const action of ["--issue", "--status", "--revoke"] as const) {
      const accepted = await deploy([
        "takoserver-integration-e2e-credentials",
        action,
        "--environment=integration",
        `--commit=${sha}`,
      ]);
      expect(accepted.exitCode).toBe(2);
      expect(accepted.stderr).toContain("deploy target descriptor not found");
      expect(accepted.stderr).not.toContain("no target was touched");
    }

    for (const args of [
      [
        "takoserver-integration-e2e-credentials",
        "--apply",
        "--environment=integration",
        `--commit=${sha}`,
      ],
      ["takoserver-worker", "--issue", "--environment=integration", `--commit=${sha}`],
      ["takoserver-worker", "--revoke", "--environment=integration", `--commit=${sha}`],
      [
        "takoserver-integration-e2e-credentials",
        "--status",
        "--environment=rehearsal",
        `--commit=${sha}`,
      ],
      [
        "takoserver-integration-e2e-credentials",
        "--issue",
        "--environment=production",
        `--commit=${sha}`,
      ],
    ] as const) {
      const refused = await deploy(args);
      expect(refused.exitCode).toBe(2);
      expect(refused.stdout).toBe("");
      expect(refused.stderr).toContain("no target was touched");
      expect(refused.stderr).not.toContain("deploy target descriptor");
    }
  });
});
