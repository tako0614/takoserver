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
  ["takoserver-sponsorship-authority-worker", ["irreversible", "authority", "published-identity"]],
  ["takoserver-worker-authority-cutover", ["authority"]],
  ["takoserver-public-parent-token-retirement", ["irreversible", "authority"]],
  ["takoserver-sponsorship-public-route-retirement", ["irreversible", "authority"]],
  ["takoserver-form-authority-identity-probe", ["authority"]],
  ["takoserver-form-authority-worker", ["authority"]],
  ["takoserver-integration-form-authority-worker", ["authority"]],
  ["takoserver-integration-form-authority-operator-worker", ["authority"]],
  ["takoserver-integration-form-authority", ["authority"]],
  ["takoserver-integration-form-authority-deactivation", ["authority"]],
  ["takoserver-integration-e2e-credentials", ["authority"]],
  ["takoserver-site", []],
  ["takoserver-console", []],
  ["takoserver-d1-schema-rehearsal-baseline", ["irreversible"]],
  ["takoserver-d1-schema", ["irreversible"]],
  ["takoserver-signing-key-register", ["irreversible", "authority", "published-identity"]],
  ["takoserver-signing-repair", ["authority"]],
  ["takoserver-signing-rotation", ["authority", "published-identity"]],
  ["takoserver-host-runtime-topology-retirement", ["irreversible", "authority"]],
  ["takoserver-hosted-token-retirement", ["irreversible", "authority"]],
  ["takoserver-worker-retirement-attribution-repair", []],
  ["takoserver-operator-identity", ["authority"]],
  ["takoserver-integration-operator-identity", ["authority"]],
  ["takoserver-managed-object-receipt-authority", ["irreversible", "authority"]],
  ["takoserver-managed-worker-dispatch-namespace", ["irreversible", "authority"]],
  ["takoserver-managed-worker-gateway", ["authority"]],
  ["cloudflare-provider-executor", ["authority"]],
  ["takoserver-exact-artifact-recovery", ["irreversible", "authority"]],
  ["takoserver-org-api-key", ["authority"]],
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
      otherProviderScripts?: { script: string; why: string }[];
    };
    expect(contract.kind).toBe("takos.deploy-contract@v2");
    expect(contract.surfaces.map(({ surface, triggers }) => [surface, triggers])).toEqual(
      SURFACES.map(([surface, triggers]) => [surface, [...triggers]]),
    );
    expect(contract.surfaces.some(({ surface }) => surface === "takoserver-api")).toBe(false);
    expect(contract.otherProviderScripts).toEqual([
      {
        script: "build:cloudflare-provider-executor",
        why: expect.stringContaining("route-less provider executor"),
      },
      {
        script: "build:managed-object-receipt-authority",
        why: expect.stringContaining("strict --dry-run bundle build"),
      },
      {
        script: "build:managed-worker-gateway",
        why: expect.stringContaining("strict --dry-run bundle build"),
      },
    ]);

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
    const sponsorshipAuthority = contract.surfaces.find(
      ({ surface }) => surface === "takoserver-sponsorship-authority-worker",
    );
    const receiptAuthority = contract.surfaces.find(
      ({ surface }) => surface === "takoserver-managed-object-receipt-authority",
    );
    const providerExecutor = contract.surfaces.find(
      ({ surface }) => surface === "cloudflare-provider-executor",
    );
    const dispatchNamespace = contract.surfaces.find(
      ({ surface }) => surface === "takoserver-managed-worker-dispatch-namespace",
    );
    const exactArtifactRecovery = contract.surfaces.find(
      ({ surface }) => surface === "takoserver-exact-artifact-recovery",
    );
    const publicParentTokenRetirement = contract.surfaces.find(
      ({ surface }) => surface === "takoserver-public-parent-token-retirement",
    );
    const routineWorker = contract.surfaces.find(({ surface }) => surface === "takoserver-worker");
    const schemaBaseline = contract.surfaces.find(
      ({ surface }) => surface === "takoserver-d1-schema-rehearsal-baseline",
    );
    const schema = contract.surfaces.find(({ surface }) => surface === "takoserver-d1-schema");
    const operatorIdentity = contract.surfaces.find(
      ({ surface }) => surface === "takoserver-operator-identity",
    );
    expect(operatorIdentity?.requiresEnv).toEqual([
      "CLOUDFLARE_API_TOKEN",
      "TAKOSERVER_INDEPENDENT_REVIEW",
      "TAKOSERVER_OPERATOR_PRIVATE_JWK_PATH",
      "TAKOSERVER_ORG_API_KEY_OPERATOR_IDENTITY_PATH",
    ]);
    expect(exactArtifactRecovery?.requiresTools).toEqual(["bun", "wrangler", "flock"]);
    expect(exactArtifactRecovery?.requiresEnv).toContain(
      "TAKOSERVER_EXACT_ARTIFACT_RECOVERY_REQUEST_PATH",
    );
    expect(exactArtifactRecovery?.obligations["post-conditions"]).toContain("no route");
    expect(exactArtifactRecovery?.obligations["post-conditions"]).toContain(
      "retains the compact terminal singleton",
    );
    expect(exactArtifactRecovery?.obligations["failure-handling"]).toContain(
      "never issues a second R2 DELETE",
    );
    expect(operatorIdentity?.obligations.provenance).toContain("--organization=<org_...>");
    expect(operatorIdentity?.obligations.reversal).toContain("non-executable");
    expect(operatorIdentity?.obligations.reversal).toContain("freshly qualified");
    expect(operatorIdentity?.obligations["post-conditions"]).toContain("owner");
    expect(operatorIdentity?.obligations["failure-handling"]).toContain("--status");
    expect(routineWorker?.requiresTools).toContain("flock");
    expect(routineWorker?.obligations.provenance).toContain("CLOUDFLARE_API_TOKEN");
    expect(routineWorker?.obligations.provenance).toContain("stored OAuth profile");
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
    expect(routineWorker?.obligations["post-conditions"]).toContain("all-traffic quiescence 503");
    expect(routineWorker?.obligations["failure-handling"]).toContain("traffic is indeterminate");
    expect(routineWorker?.obligations["failure-handling"]).toContain("0037-0043");
    expect(routineWorker?.obligations["failure-handling"]).toContain("all-traffic");
    expect(routineWorker?.obligations["failure-handling"]).toContain(
      "never claims that no target was touched",
    );
    expect(routineWorker?.obligations["failure-handling"]).not.toContain(
      "uploaded Version is inactive",
    );
    expect(routineWorker?.obligations["failure-handling"]).toContain("credential resolver");
    expect(schemaBaseline?.obligations.provenance).toContain("fixed empty-to-0022");
    expect(schemaBaseline?.obligations["failure-handling"]).toContain(
      "cannot emit production rehearsal evidence",
    );
    expect(schema?.obligations.provenance).toContain("fixed next boundaries 0022, 0028");
    expect(schema?.obligations.provenance).toContain("one-time exact 0016-to-0022 catch-up");
    expect(schema?.obligations.provenance).toContain("0045");
    expect(schema?.obligations.provenance).toContain("0046");
    expect(schema?.obligations.provenance).toContain("0047");
    expect(schema?.obligations["post-conditions"]).toContain(
      "exact artifact-recovery singleton and its receipt constraints",
    );
    expect(schema?.obligations["post-conditions"]).toContain(
      "sponsorship issuance admission and cutover-consumption receipts",
    );
    expect(schema?.requiresEnv).toContain("TAKOSERVER_ARTIFACT_BLOB_IO_QUIESCENCE_RECEIPT_PATH");
    expect(schema?.obligations["pre-mutation-proof"]).toContain("malformed FormRef");
    expect(schema?.obligations["pre-mutation-proof"]).toContain(
      "active-root/deleting-candidate conflict",
    );
    expect(schema?.obligations["pre-mutation-proof"]).toContain("current and immediate rollback");
    expect(schema?.obligations["pre-mutation-proof"]).toContain("public preview URLs are disabled");
    expect(schema?.obligations["pre-mutation-proof"]).toContain("immediately before");
    expect(schema?.obligations["pre-mutation-proof"]).toContain(
      "frozen canonical application-schema digest",
    );
    expect(schema?.obligations["pre-mutation-proof"]).toContain(
      "never treats REST query execution as D1Database.batch()",
    );
    expect(schema?.obligations["failure-handling"]).toContain("immediate authoritative");
    expect(schema?.obligations["failure-handling"]).toContain(
      "TAKOSERVER_ARTIFACT_BLOB_IO_QUIESCENCE_RECEIPT_PATH",
    );
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
    expect(sponsorshipAuthority?.obligations.provenance).toContain(
      "target pins the only organization and Worker name",
    );
    expect(sponsorshipAuthority?.obligations["post-conditions"]).toContain(
      "Hosted's exact service-binding release",
    );
    expect(sponsorshipAuthority?.obligations["post-conditions"]).toContain(
      "bounded authenticated staging credential issuance/readback",
    );
    expect(receiptAuthority?.obligations["post-conditions"]).toContain("--secrets-file");
    expect(receiptAuthority?.obligations["post-conditions"]).toContain("custom domains");
    expect(receiptAuthority?.obligations["post-conditions"]).toContain("removed");
    expect(receiptAuthority?.obligations["pre-mutation-proof"]).toContain("null predecessor");
    expect(receiptAuthority?.requiresEnv).not.toContain(
      "TAKOSERVER_CLOUDFLARE_PROVIDER_INSTALLATION_ID",
    );
    expect(providerExecutor?.obligations["post-conditions"]).toContain(
      "Namespace readiness precedes gateway deployment; receipt authority and gateway readiness precede executor deployment",
    );
    expect(providerExecutor?.obligations["post-conditions"]).toContain("Migration 0045");
    expect(dispatchNamespace?.obligations.provenance).toContain("bootstrap projection");
    expect(dispatchNamespace?.obligations["post-conditions"]).toContain("created-needs-target-pin");
    expect(dispatchNamespace?.obligations.reversal).toContain("No delete, rename, reverse");
    expect(dispatchNamespace?.obligations["pre-mutation-proof"]).toContain("rehearsal receipt");
    expect(gateway?.requiresEnv).not.toContain("TAKOSERVER_MANAGED_WORKER_DISPATCH_NAMESPACE");
    expect(providerExecutor?.obligations.reversal).toContain("immediate predecessor");
    expect(providerExecutor?.obligations.provenance).toContain(
      "TAKOSERVER_DEPLOY_TARGET_<ENVIRONMENT>",
    );
    expect(providerExecutor?.obligations.provenance).toContain(
      ".operator-private/takoserver/<environment>/target.v2.json",
    );
    expect(providerExecutor?.obligations.provenance).toContain(".deploy/target.staging.json");
    expect(providerExecutor?.obligations.provenance).toContain("receiptAuthorityWorkerName");
    expect(publicParentTokenRetirement?.requiresEnv).toEqual([
      "CLOUDFLARE_API_TOKEN",
      "TAKOSERVER_INDEPENDENT_REVIEW",
    ]);
    expect(publicParentTokenRetirement?.requiresTools).toContain("flock");
    expect(publicParentTokenRetirement?.obligations["post-conditions"]).toContain(
      "CLOUDFLARE_PROVIDER_EXECUTOR",
    );
    expect(publicParentTokenRetirement?.obligations["post-conditions"]).toContain(
      "CLOUDFLARE_API_TOKEN",
    );
    expect(publicParentTokenRetirement?.obligations.provenance).toContain("source.changedPaths");
    expect(publicParentTokenRetirement?.obligations["failure-handling"]).toContain("--status");
    expect(publicParentTokenRetirement?.obligations.reversal).toContain("forward-only");
    expect(JSON.stringify(publicParentTokenRetirement)).not.toContain(
      "TAKOSERVER_CLOUDFLARE_PROVIDER_EXECUTOR_SECRETS_PATH",
    );
    expect(sponsorshipAuthority?.requiresEnv).toEqual([
      "CLOUDFLARE_API_TOKEN",
      "TAKOSERVER_INDEPENDENT_REVIEW",
      "TAKOSERVER_SPONSORSHIP_CREDENTIAL_PRIVATE_JWK_PATH",
      "TAKOSERVER_SPONSORSHIP_RECEIPT_PRIVATE_JWK_PATH",
      "TAKOSERVER_CLOUDFLARE_TOPOLOGY_AUDIT_CREDENTIAL",
    ]);
    const routeRetirement = contract.surfaces.find(
      ({ surface }) => surface === "takoserver-sponsorship-public-route-retirement",
    );
    const tokenRetirement = contract.surfaces.find(
      ({ surface }) => surface === "takoserver-hosted-token-retirement",
    );
    for (const retirement of [routeRetirement, tokenRetirement]) {
      expect(retirement?.requiresEnv).toEqual([
        "CLOUDFLARE_API_TOKEN",
        "TAKOSERVER_INDEPENDENT_REVIEW",
        "TAKOSERVER_SPONSORSHIP_CUTOVER_PROOF_PATH",
        "TAKOSERVER_SPONSORSHIP_CUTOVER_PROOF_SHA256",
        "TAKOSERVER_CLOUDFLARE_TOPOLOGY_AUDIT_CREDENTIAL",
      ]);
      expect(retirement?.obligations["pre-mutation-proof"]).toContain(
        "0047_sponsorship_cutover_consumption.sql",
      );
      expect(retirement?.obligations["pre-mutation-proof"]).toContain("0046");
      expect(retirement?.obligations["failure-handling"]).toContain("remote STATE_DB");
    }
    expect(routeRetirement?.obligations.provenance).toContain("append-only Hosted 0003 receipt");
    expect(routeRetirement?.obligations.provenance).toContain("public Worker predecessor");
    expect(routeRetirement?.obligations.provenance).toContain("all-zone");

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

  test("keeps public parent-token retirement fixed to target-derived identity and one action", async () => {
    const sha = "a".repeat(40);
    for (const environment of ["integration", "rehearsal", "production"] as const) {
      for (const action of ["--status", "--apply"] as const) {
        const accepted = await deploy([
          "takoserver-public-parent-token-retirement",
          action,
          `--environment=${environment}`,
          `--commit=${sha}`,
        ]);
        expect(accepted.exitCode).toBe(2);
        expect(accepted.stderr).toContain("deploy target descriptor not found");
        expect(accepted.stderr).not.toContain("no target was touched");
      }
    }

    for (const extra of [
      "--worker=some-worker",
      `--account=${"2".repeat(32)}`,
      "--secret=TAKOSERVER_SIGNING_KEY",
      "--cwd=/tmp",
      "--reverse",
      "--add-secret=UNRELATED_SECRET",
    ]) {
      const refused = await deploy([
        "takoserver-public-parent-token-retirement",
        "--status",
        "--environment=integration",
        `--commit=${sha}`,
        extra,
      ]);
      expect(refused.exitCode).toBe(2);
      expect(refused.stdout).toBe("");
      expect(refused.stderr).toContain("no target was touched");
      expect(refused.stderr).not.toContain("deploy target descriptor");
    }
  });

  test("parses only the fixed rehearsal baseline and approved schema wave boundaries", async () => {
    const sha = "a".repeat(40);
    const baseline = await deploy([
      "takoserver-d1-schema-rehearsal-baseline",
      "--status",
      "--environment=rehearsal",
      `--commit=${sha}`,
    ]);
    expect(baseline.exitCode).toBe(2);
    expect(baseline.stderr).toContain("deploy target descriptor not found");
    expect(baseline.stderr).not.toContain("no target was touched");

    for (const through of [
      "0022",
      "0028",
      "0033",
      "0036",
      "0043",
      "0044",
      "0045",
      "0046",
      "0047",
      "0048",
      "0049",
    ] as const) {
      for (const environment of ["rehearsal", "production"] as const) {
        const accepted = await deploy([
          "takoserver-d1-schema",
          "--status",
          `--environment=${environment}`,
          `--commit=${sha}`,
          `--through-migration=${through}`,
        ]);
        expect(accepted.exitCode).toBe(2);
        expect(accepted.stderr).toContain("deploy target descriptor not found");
        expect(accepted.stderr).not.toContain("no target was touched");
      }
    }

    const integrationWithoutWave = await deploy([
      "takoserver-d1-schema",
      "--status",
      "--environment=integration",
      `--commit=${sha}`,
    ]);
    expect(integrationWithoutWave.exitCode).toBe(2);
    expect(integrationWithoutWave.stderr).toContain("deploy target descriptor not found");
    expect(integrationWithoutWave.stderr).not.toContain("no target was touched");

    for (const through of [
      "0022",
      "0028",
      "0033",
      "0036",
      "0043",
      "0044",
      "0045",
      "0046",
      "0047",
      "0048",
      "0049",
    ] as const) {
      const refused = await deploy([
        "takoserver-d1-schema",
        "--status",
        "--environment=integration",
        `--commit=${sha}`,
        `--through-migration=${through}`,
      ]);
      expect(refused.exitCode).toBe(2);
      expect(refused.stdout).toBe("");
      expect(refused.stderr).toContain("no target was touched");
      expect(refused.stderr).not.toContain("deploy target descriptor");
    }

    for (const args of [
      [
        "takoserver-d1-schema-rehearsal-baseline",
        "--status",
        "--environment=integration",
        `--commit=${sha}`,
      ],
      [
        "takoserver-d1-schema-rehearsal-baseline",
        "--status",
        "--environment=production",
        `--commit=${sha}`,
      ],
      [
        "takoserver-d1-schema-rehearsal-baseline",
        "--status",
        "--environment=rehearsal",
        `--commit=${sha}`,
        "--through-migration=0028",
      ],
      ["takoserver-d1-schema", "--status", "--environment=rehearsal", `--commit=${sha}`],
      ["takoserver-d1-schema", "--status", "--environment=production", `--commit=${sha}`],
      [
        "takoserver-d1-schema",
        "--status",
        "--environment=production",
        `--commit=${sha}`,
        "--through-migration=0029",
      ],
      [
        "takoserver-d1-schema",
        "--status",
        "--environment=production",
        `--commit=${sha}`,
        "--through-migration=0028_too_much",
      ],
      [
        "takoserver-worker",
        "--status",
        "--environment=production",
        `--commit=${sha}`,
        "--through-migration=0028",
      ],
    ] as const) {
      const refused = await deploy(args);
      expect(refused.exitCode).toBe(2);
      expect(refused.stdout).toBe("");
      expect(refused.stderr).toContain("no target was touched");
      expect(refused.stderr).not.toContain("deploy target descriptor");
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
      "takoserver-sponsorship-public-route-retirement",
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
        "takoserver-sponsorship-public-route-retirement",
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
        "--status",
        "--environment=integration",
        `--commit=${sha}`,
        `--legacy-host-runtime-predecessor-version=${version}`,
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
        "takoserver-sponsorship-authority-worker",
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

  test("accepts provider-executor reverse only as an apply mutation", async () => {
    const sha = "a".repeat(40);
    const accepted = await deploy([
      "cloudflare-provider-executor",
      "--apply",
      "--environment=integration",
      `--commit=${sha}`,
      "--reverse",
    ]);
    expect(accepted.exitCode).toBe(2);
    expect(accepted.stderr).toContain("deploy target descriptor not found");
    expect(accepted.stderr).not.toContain("no target was touched");

    const refused = await deploy([
      "cloudflare-provider-executor",
      "--status",
      "--environment=integration",
      `--commit=${sha}`,
      "--reverse",
    ]);
    expect(refused.exitCode).toBe(2);
    expect(refused.stderr).toContain("no target was touched");
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

  test("parses the canonical operator identity surface for every environment", async () => {
    const sha = "a".repeat(40);
    for (const environment of ["integration", "rehearsal", "production"] as const) {
      const accepted = await deploy([
        "takoserver-operator-identity",
        "--status",
        `--environment=${environment}`,
        `--commit=${sha}`,
        "--organization=org_operator_owner",
      ]);
      expect(accepted.exitCode).toBe(2);
      expect(accepted.stderr).toContain("deploy target descriptor not found");
      expect(accepted.stderr).not.toContain("no target was touched");
    }

    for (const args of [
      ["takoserver-operator-identity", "--status", "--environment=integration", `--commit=${sha}`],
      [
        "takoserver-operator-identity",
        "--status",
        "--environment=production",
        `--commit=${sha}`,
        "--organization=org_operator_owner",
        "--key-name=unexpected",
      ],
      [
        "takoserver-operator-identity",
        "--status",
        "--environment=production",
        `--commit=${sha}`,
        "--organization=org_operator_owner",
        "--scope=resources:read",
      ],
    ] as const) {
      const refused = await deploy([...args]);
      expect(refused.exitCode).toBe(2);
      expect(refused.stdout).toBe("");
      expect(refused.stderr).toContain("no target was touched");
      expect(refused.stderr).not.toContain("deploy target descriptor");
    }
  });

  test("keeps the legacy operator identity spelling integration-only", async () => {
    const sha = "a".repeat(40);
    const accepted = await deploy([
      "takoserver-integration-operator-identity",
      "--status",
      "--environment=integration",
      `--commit=${sha}`,
      "--organization=org_operator_owner",
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
        "--organization=org_operator_owner",
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

  test("parses exact artifact recovery only through the integration deploy surface", async () => {
    const sha = "a".repeat(40);
    const accepted = await deploy([
      "takoserver-exact-artifact-recovery",
      "--status",
      "--environment=integration",
      `--commit=${sha}`,
    ]);
    expect(accepted.exitCode).toBe(2);
    expect(accepted.stderr).toContain("deploy target descriptor not found");
    expect(accepted.stderr).not.toContain("no target was touched");

    for (const environment of ["rehearsal", "production"] as const) {
      const refused = await deploy([
        "takoserver-exact-artifact-recovery",
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

  test("declares the reviewed closure transition and parses only its exact selector", async () => {
    const probe = await deploy(["--contract"]);
    const contract = JSON.parse(probe.stdout) as {
      surfaces: { surface: string; obligations: Record<string, string> }[];
    };
    const cutover = contract.surfaces.find(
      ({ surface }) => surface === "takoserver-worker-authority-cutover",
    );
    expect(cutover?.obligations["failure-handling"]).toContain(
      "--closure-predecessor-version=<uuid>",
    );
    expect(cutover?.obligations["failure-handling"]).toContain("--rotate-secret=NAME");
    expect(cutover?.obligations["failure-handling"]).toContain("--refresh-var=NAME");
    expect(cutover?.obligations["failure-handling"]).toContain("The routine surfaces stay strict");
    expect(cutover?.obligations["failure-handling"]).toContain(
      "Production accepts this transition only with the exact pinned predecessor Version ID",
    );
    expect(cutover?.obligations).not.toHaveProperty("production-selector");
    expect(cutover?.obligations).not.toHaveProperty("closure-transition-selector");

    const sha = "a".repeat(40);
    const predecessor = "00000000-0000-4000-8000-0000000000a1";
    for (const environment of ["integration", "rehearsal", "production"] as const) {
      const accepted = await deploy([
        "takoserver-worker-authority-cutover",
        "--status",
        `--environment=${environment}`,
        `--commit=${sha}`,
        `--closure-predecessor-version=${predecessor}`,
        "--retire-var=TAKOSERVER_STANDARD_SERVICE_SUPPLIES",
        "--add-var=TAKOSERVER_OBJECT_BUCKET_SUPPLIES",
        "--refresh-var=TAKOSERVER_EDGE_SUPPLIES",
        "--add-secret=TAKOSERVER_RUNTIME_INPUT_SEAL_KEYRING",
        "--rotate-secret=CLOUDFLARE_API_TOKEN",
      ]);
      expect(accepted.exitCode).toBe(2);
      expect(accepted.stderr).toContain("deploy target descriptor not found");
      expect(accepted.stderr).not.toContain("no target was touched");
    }

    for (const args of [
      // Routine surfaces never accept the selector.
      [
        "takoserver-worker",
        "--status",
        "--environment=integration",
        `--commit=${sha}`,
        `--closure-predecessor-version=${predecessor}`,
        "--retire-var=TAKOSERVER_STANDARD_SERVICE_SUPPLIES",
      ],
      // The declaration must not be empty.
      [
        "takoserver-worker-authority-cutover",
        "--status",
        "--environment=integration",
        `--commit=${sha}`,
        `--closure-predecessor-version=${predecessor}`,
      ],
      // A delta without the selector is not an invocation.
      [
        "takoserver-worker-authority-cutover",
        "--status",
        "--environment=integration",
        `--commit=${sha}`,
        "--retire-var=TAKOSERVER_STANDARD_SERVICE_SUPPLIES",
      ],
      // The three predecessor selectors are mutually exclusive.
      [
        "takoserver-worker-authority-cutover",
        "--status",
        "--environment=integration",
        `--commit=${sha}`,
        `--closure-predecessor-version=${predecessor}`,
        `--legacy-predecessor-version=${predecessor}`,
        "--add-var=TAKOSERVER_OBJECT_BUCKET_SUPPLIES",
      ],
      // A closure transition has no reversal selector.
      [
        "takoserver-worker-authority-cutover",
        "--apply",
        "--environment=integration",
        `--commit=${sha}`,
        `--closure-predecessor-version=${predecessor}`,
        "--add-var=TAKOSERVER_OBJECT_BUCKET_SUPPLIES",
        "--reverse",
      ],
      // One binding may appear in the declaration only once.
      [
        "takoserver-worker-authority-cutover",
        "--status",
        "--environment=integration",
        `--commit=${sha}`,
        `--closure-predecessor-version=${predecessor}`,
        "--add-secret=CLOUDFLARE_API_TOKEN",
        "--rotate-secret=CLOUDFLARE_API_TOKEN",
      ],
      // Binding names are exact.
      [
        "takoserver-worker-authority-cutover",
        "--status",
        "--environment=integration",
        `--commit=${sha}`,
        `--closure-predecessor-version=${predecessor}`,
        "--add-var=takoserver_object_bucket_supplies",
      ],
      // A refreshed var is still one binding named once.
      [
        "takoserver-worker-authority-cutover",
        "--status",
        "--environment=integration",
        `--commit=${sha}`,
        `--closure-predecessor-version=${predecessor}`,
        "--refresh-var=TAKOSERVER_EDGE_SUPPLIES",
        "--retire-var=TAKOSERVER_EDGE_SUPPLIES",
      ],
      // And the routine surface never accepts it either.
      [
        "takoserver-worker",
        "--status",
        "--environment=integration",
        `--commit=${sha}`,
        `--closure-predecessor-version=${predecessor}`,
        "--refresh-var=TAKOSERVER_EDGE_SUPPLIES",
      ],
    ] as const) {
      const refused = await deploy(args);
      expect(refused.exitCode).toBe(2);
      expect(refused.stdout).toBe("");
      expect(refused.stderr).toContain("no target was touched");
      expect(refused.stderr).not.toContain("deploy target descriptor");
    }
  });

  test("offers the same forward transition to every Worker-publishing surface", async () => {
    const sha = "a".repeat(40);
    const predecessor = "00000000-0000-4000-8000-0000000000a1";
    for (const [surface, environment] of [
      ["takoserver-form-authority-identity-probe", "production"],
      ["takoserver-form-authority-worker", "production"],
      ["takoserver-integration-form-authority-worker", "integration"],
      ["takoserver-integration-form-authority-operator-worker", "integration"],
    ] as const) {
      const accepted = await deploy([
        surface,
        "--status",
        `--environment=${environment}`,
        `--commit=${sha}`,
        `--closure-predecessor-version=${predecessor}`,
        "--refresh-var=TAKOSERVER_FORM_AUTHORITY_CAPABILITY_MANIFEST",
        "--add-binding=FORM_AUTHORITY",
      ]);
      expect(accepted.exitCode).toBe(2);
      expect(accepted.stderr).toContain("deploy target descriptor not found");
      expect(accepted.stderr).not.toContain("no target was touched");

      // The candidate descriptor is a readback product; it never accompanies a mutation.
      const adopt = await deploy([
        surface,
        "--status",
        `--environment=${environment}`,
        `--commit=${sha}`,
        "--adopt-live=/tmp/takoserver-adopt-candidate.json",
      ]);
      expect(adopt.exitCode).toBe(2);
      expect(adopt.stderr).toContain("deploy target descriptor not found");
    }

    for (const args of [
      // `--adopt-live` never accompanies an apply.
      [
        "takoserver-integration-form-authority-worker",
        "--apply",
        "--environment=integration",
        `--commit=${sha}`,
        "--adopt-live=/tmp/takoserver-adopt-candidate.json",
      ],
      // Nor a surface with no descriptor-owned identity in its closure.
      [
        "takoserver-worker",
        "--status",
        "--environment=integration",
        `--commit=${sha}`,
        "--adopt-live=/tmp/takoserver-adopt-candidate.json",
      ],
      // The candidate path is absolute.
      [
        "takoserver-integration-form-authority-worker",
        "--status",
        "--environment=integration",
        `--commit=${sha}`,
        "--adopt-live=candidate.json",
      ],
      // A signed-invocation surface publishes no Worker and takes no declaration.
      [
        "takoserver-integration-form-authority",
        "--status",
        "--environment=integration",
        `--commit=${sha}`,
        `--closure-predecessor-version=${predecessor}`,
        "--add-binding=FORM_AUTHORITY",
      ],
      // An added binding is still one exact binding name.
      [
        "takoserver-form-authority-identity-probe",
        "--status",
        "--environment=production",
        `--commit=${sha}`,
        `--closure-predecessor-version=${predecessor}`,
        "--add-binding=form_authority",
      ],
    ] as const) {
      const refused = await deploy(args);
      expect(refused.exitCode).toBe(2);
      expect(refused.stdout).toBe("");
      expect(refused.stderr).toContain("no target was touched");
      expect(refused.stderr).not.toContain("deploy target descriptor");
    }
  });

  /**
   * The released-Core lane could not be started: its apply post-condition reads
   * a probe route the probe serves only through a binding it refuses to
   * publish while the authority Worker is absent. The order is now declared,
   * on one surface's one mutating action.
   */
  test("parses the released-Core bootstrap deferral only where it can mean something", async () => {
    const probe = await deploy(["--contract"]);
    const contract = JSON.parse(probe.stdout) as {
      surfaces: { surface: string; obligations: Record<string, string> }[];
    };
    const authority = contract.surfaces.find(
      ({ surface }) => surface === "takoserver-form-authority-worker",
    );
    expect(authority?.obligations).not.toHaveProperty("bootstrap-selector");
    expect(authority?.obligations["failure-handling"]).toContain("--bootstrap-verifier-bridge");
    expect(authority?.obligations["failure-handling"]).toContain(
      "--bootstrap-probe-predecessor-version=<uuid>",
    );
    expect(authority?.obligations["failure-handling"]).toContain(
      "identity probe's exact predecessor Version",
    );
    expect(authority?.obligations["failure-handling"]).toContain(
      "this released-Core Worker's `--apply`",
    );
    expect(authority?.obligations["failure-handling"]).toContain("an adoption or reverse");
    expect(authority?.obligations["failure-handling"]).toContain("has no Version at all");
    expect(authority?.obligations["failure-handling"]).toContain("coreVerifierRpcReady: true");
    expect(authority?.obligations["failure-handling"]).toContain(
      "steady-state post-condition is never relaxed",
    );
    expect(authority?.obligations.reversal).toContain("forward repair");

    for (const surface of contract.surfaces) {
      const unknown = Object.keys(surface.obligations).filter(
        (name) =>
          ![
            "provenance",
            "post-conditions",
            "reversal",
            "failure-handling",
            "pre-mutation-proof",
            "independent-review",
            "no-overwrite",
            "halt",
          ].includes(name),
      );
      expect(unknown).toEqual([]);
    }

    const sha = "a".repeat(40);
    const predecessor = "00000000-0000-4000-8000-0000000000a1";
    const probePredecessor = "00000000-0000-4000-8000-0000000000b1";
    const accepted = await deploy([
      "takoserver-form-authority-worker",
      "--apply",
      "--environment=integration",
      `--commit=${sha}`,
      "--bootstrap-verifier-bridge",
      `--bootstrap-probe-predecessor-version=${probePredecessor}`,
    ]);
    expect(accepted.exitCode).toBe(2);
    expect(accepted.stderr).toContain("deploy target descriptor not found");

    for (const args of [
      // Bootstrap requires the probe's exact predecessor pin.
      [
        "takoserver-form-authority-worker",
        "--apply",
        "--environment=integration",
        `--commit=${sha}`,
        "--bootstrap-verifier-bridge",
      ],
      // The probe predecessor selector is a Worker Version UUID.
      [
        "takoserver-form-authority-worker",
        "--apply",
        "--environment=integration",
        `--commit=${sha}`,
        "--bootstrap-verifier-bridge",
        "--bootstrap-probe-predecessor-version=not-a-version-id",
      ],
      // It is a single exact predecessor, not a repeatable declaration.
      [
        "takoserver-form-authority-worker",
        "--apply",
        "--environment=integration",
        `--commit=${sha}`,
        "--bootstrap-verifier-bridge",
        `--bootstrap-probe-predecessor-version=${probePredecessor}`,
        `--bootstrap-probe-predecessor-version=${probePredecessor}`,
      ],
      // The selector without its bridge is not a standalone action.
      [
        "takoserver-form-authority-worker",
        "--apply",
        "--environment=integration",
        `--commit=${sha}`,
        `--bootstrap-probe-predecessor-version=${probePredecessor}`,
      ],
      // The readback bridge belongs to the released-Core authority alone.
      [
        "takoserver-integration-form-authority-worker",
        "--apply",
        "--environment=integration",
        `--commit=${sha}`,
        "--bootstrap-verifier-bridge",
        `--bootstrap-probe-predecessor-version=${probePredecessor}`,
      ],
      [
        "takoserver-form-authority-identity-probe",
        "--apply",
        "--environment=integration",
        `--commit=${sha}`,
        "--bootstrap-verifier-bridge",
        `--bootstrap-probe-predecessor-version=${probePredecessor}`,
      ],
      // A readback deferral has nothing to defer on a read-only invocation.
      [
        "takoserver-form-authority-worker",
        "--status",
        "--environment=integration",
        `--commit=${sha}`,
        "--bootstrap-verifier-bridge",
        `--bootstrap-probe-predecessor-version=${probePredecessor}`,
      ],
      // A first upload has no predecessor Version to pin.
      [
        "takoserver-form-authority-worker",
        "--apply",
        "--environment=integration",
        `--commit=${sha}`,
        "--bootstrap-verifier-bridge",
        `--bootstrap-probe-predecessor-version=${probePredecessor}`,
        `--closure-predecessor-version=${predecessor}`,
        "--add-binding=CORE_VERIFIER",
      ],
      // Nor an authority scope transition.
      [
        "takoserver-form-authority-worker",
        "--apply",
        "--environment=integration",
        `--commit=${sha}`,
        "--bootstrap-verifier-bridge",
        `--bootstrap-probe-predecessor-version=${probePredecessor}`,
        "--form-authority-scope-transition=/tmp/takoserver-scope.json",
      ],
      // Nor a live value to adopt from.
      [
        "takoserver-form-authority-worker",
        "--status",
        "--environment=integration",
        `--commit=${sha}`,
        "--bootstrap-verifier-bridge",
        `--bootstrap-probe-predecessor-version=${probePredecessor}`,
        "--adopt-live=/tmp/takoserver-adopt-candidate.json",
      ],
      // Nor a reverse mutation.
      [
        "takoserver-form-authority-worker",
        "--apply",
        "--environment=integration",
        `--commit=${sha}`,
        "--bootstrap-verifier-bridge",
        `--bootstrap-probe-predecessor-version=${probePredecessor}`,
        "--reverse",
      ],
      // Named once.
      [
        "takoserver-form-authority-worker",
        "--apply",
        "--environment=integration",
        `--commit=${sha}`,
        "--bootstrap-verifier-bridge",
        `--bootstrap-probe-predecessor-version=${probePredecessor}`,
        "--bootstrap-verifier-bridge",
      ],
    ] as const) {
      const refused = await deploy(args);
      expect(refused.exitCode).toBe(2);
      expect(refused.stdout).toBe("");
      expect(refused.stderr).toContain("no target was touched");
      expect(refused.stderr).not.toContain("deploy target descriptor");
    }
  });

  test("parses only the exact durable organization API key operands", async () => {
    const probe = await deploy(["--contract"]);
    const contract = JSON.parse(probe.stdout) as {
      surfaces: { surface: string; requiresEnv: string[]; obligations: Record<string, string> }[];
    };
    const surface = contract.surfaces.find(({ surface }) => surface === "takoserver-org-api-key");
    expect(surface?.requiresEnv).toEqual([
      "TAKOSERVER_OPERATOR_PRIVATE_JWK_PATH",
      "TAKOSERVER_ORG_API_KEY_OPERATOR_IDENTITY_PATH",
      "TAKOSERVER_ORG_API_KEY_OUTPUT_DIRECTORY",
      "TAKOSERVER_INDEPENDENT_REVIEW",
    ]);
    expect(surface?.obligations["post-conditions"]).toContain("an unbounded organization API key");
    expect(surface?.obligations.reversal).toContain("--revoke");

    const sha = "a".repeat(40);
    const organization = "org_takosumi_hosted_staging";
    const keyId = `key_${"1".repeat(40)}`;
    for (const [environment, args] of [
      ["integration", ["--status", `--organization=${organization}`]],
      [
        "rehearsal",
        [
          "--mint",
          `--organization=${organization}`,
          "--key-name=takosumi-hosted-reservation",
          "--scope=resources:write",
          "--scope=resources:read",
          "--expires-in-days=90",
        ],
      ],
      ["production", ["--revoke", `--organization=${organization}`, `--key-id=${keyId}`]],
    ] as const) {
      const accepted = await deploy([
        "takoserver-org-api-key",
        `--environment=${environment}`,
        `--commit=${sha}`,
        ...args,
      ]);
      expect(accepted.exitCode).toBe(2);
      expect(accepted.stderr).toContain("deploy target descriptor not found");
      expect(accepted.stderr).not.toContain("no target was touched");
    }

    for (const args of [
      // Every action names the organization.
      ["takoserver-org-api-key", "--status", "--environment=integration", `--commit=${sha}`],
      // A mint declares name, scope and a bounded expiry.
      [
        "takoserver-org-api-key",
        "--mint",
        "--environment=integration",
        `--commit=${sha}`,
        `--organization=${organization}`,
        "--key-name=takosumi-hosted-reservation",
        "--scope=resources:write",
      ],
      // An unbounded expiry is not expressible.
      [
        "takoserver-org-api-key",
        "--mint",
        "--environment=integration",
        `--commit=${sha}`,
        `--organization=${organization}`,
        "--key-name=takosumi-hosted-reservation",
        "--scope=resources:write",
        "--expires-in-days=0",
      ],
      // An unknown scope is refused before a target is opened.
      [
        "takoserver-org-api-key",
        "--mint",
        "--environment=integration",
        `--commit=${sha}`,
        `--organization=${organization}`,
        "--key-name=takosumi-hosted-reservation",
        "--scope=resources:everything",
        "--expires-in-days=90",
      ],
      // Revoke names one exact key id and nothing a mint would name.
      [
        "takoserver-org-api-key",
        "--revoke",
        "--environment=integration",
        `--commit=${sha}`,
        `--organization=${organization}`,
        "--key-name=takosumi-hosted-reservation",
        `--key-id=${keyId}`,
      ],
      // `--apply` is not one of this surface's actions.
      [
        "takoserver-org-api-key",
        "--apply",
        "--environment=integration",
        `--commit=${sha}`,
        `--organization=${organization}`,
      ],
      // And `--mint` belongs to no other surface.
      ["takoserver-worker", "--mint", "--environment=integration", `--commit=${sha}`],
      // This surface publishes no Worker, so it carries no closure declaration.
      [
        "takoserver-org-api-key",
        "--status",
        "--environment=integration",
        `--commit=${sha}`,
        `--organization=${organization}`,
        "--refresh-var=TAKOSERVER_ENVIRONMENT",
      ],
      // Key operands belong to no other surface either.
      [
        "takoserver-worker",
        "--status",
        "--environment=integration",
        `--commit=${sha}`,
        `--organization=${organization}`,
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
