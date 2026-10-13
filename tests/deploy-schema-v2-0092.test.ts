import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { appendFileSync, chmodSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveExpectedApplicationShape } from "../scripts/deploy/application-schema-shape.ts";
import { buildD1MigrationImport } from "../scripts/deploy/d1-migration-import.ts";
import { verifyCanonicalV20092IntegrationStorageTarget } from "../scripts/deploy/integration-storage-generation.ts";
import {
  type CanonicalV20092DispatchBinding,
  type CanonicalV20092OwnerProofInput,
  canonicalIntegrationV2Schema0092Matches,
  canonicalV20092DispatchBindingDigest,
  projectCanonicalIntegrationV2MigrationArtifact0092,
  readCurrentAuditedMigrationSourceArtifact,
  runD1Schema,
  type SchemaProcess,
} from "../scripts/deploy/schema.ts";
import {
  assertSchemaV20092PostProof,
  inspectSchemaV20092WalletProof,
  type SchemaV20092WalletProof,
} from "../scripts/deploy/schema-v2-0092-proof.ts";
import type { DeployTarget } from "../scripts/deploy/target.ts";
import { integrationStorageVerificationOptions } from "./helpers/integration-storage-generation-verification.ts";

const source = readCurrentAuditedMigrationSourceArtifact();
const commit = "a".repeat(40);
const generation = "1".repeat(32);
const databaseName = `takoserver-i-${generation}`;
const target = {
  kind: "takoserver.deploy-target@v2",
  environment: "integration",
  accountId: "a".repeat(32),
  workerName: "takoserver-api-integration",
  d1: { databaseName, databaseId: "00000000-0000-4000-8000-000000000092" },
  r2: { bucketName: databaseName },
  publicOrigin: "https://api.integration.example.test",
  signing: { currentKeyId: "current" },
  takoformV2: {
    config: JSON.stringify({
      documentation: "https://docs.example.test/v2",
      authenticationDocumentation: "https://docs.example.test/v2/authentication",
    }),
    storageLineage: "v2-0088",
  },
} satisfies DeployTarget;
const productionD1 = {
  databaseName: "takoserver-runtime-production",
  databaseId: "00000000-0000-4000-8000-000000000001",
};
const identityProvider = {
  async getD1(databaseId: string) {
    if (databaseId !== target.d1.databaseId) throw new Error("unexpected D1 identity GET");
    return { uuid: databaseId, name: target.d1.databaseName };
  },
  async getR2(name: string) {
    return { name };
  },
};

function state(count: number) {
  const shape = deriveExpectedApplicationShape(source.files.slice(0, count));
  return {
    applied: source.names.slice(0, count),
    shape,
    shapeDigest: `sha256:${createHash("sha256").update(shape).digest("hex")}`,
  };
}

function proof(): SchemaV20092WalletProof {
  return {
    protectedRows: { ledger: 0, wallet_credit_lots: 0, wallet_credit_allocations: 0 },
    protectedDigest: `sha256:${"a".repeat(64)}`,
    foreignKeyViolations: 0,
    invalidCursorCount: null,
    newTableRows: null,
  };
}

describe("canonical integration 0088 to 0092 schema", () => {
  test("fixed source projection and pure exact-applied validator refuse marker-only and shape drift", () => {
    expect(projectCanonicalIntegrationV2MigrationArtifact0092(source).digest).toBe(
      "sha256:6f7c1016b7ffeeb7c02006cdb8e55dc7919bfc2aeaf04c090001dcf423454be2",
    );
    expect(canonicalIntegrationV2Schema0092Matches(state(92), source)).toBe(true);
    expect(canonicalIntegrationV2Schema0092Matches(state(91), source)).toBe(false);
    expect(canonicalIntegrationV2Schema0092Matches({ ...state(92), shape: "[]\n" }, source)).toBe(
      false,
    );
    expect(
      canonicalIntegrationV2Schema0092Matches(state(92), { ...source, digest: "sha256:foreign" }),
    ).toBe(false);
  });

  test("Worker storage readback requires explicit successor plus exact generated D1/R2 and shape", async () => {
    const selected = {
      ...target,
      takoformV2: { ...target.takoformV2, appliedSchemaLineage: "v2-0092" as const },
    };
    const options = integrationStorageVerificationOptions(selected, {
      readState: async () => state(92),
    });
    expect(
      await verifyCanonicalV20092IntegrationStorageTarget(selected, "integration", options),
    ).toMatchObject({
      appliedSchemaLineage: "v2-0092",
      appliedMigrations: source.names,
      d1: target.d1,
    });
    await expect(
      verifyCanonicalV20092IntegrationStorageTarget(target, "integration", options),
    ).rejects.toThrow("explicit applied lineage");
    await expect(
      verifyCanonicalV20092IntegrationStorageTarget(selected, "integration", {
        ...options,
        reader: { read: async () => state(91) },
      }),
    ).rejects.toThrow("lineage");
    await expect(
      verifyCanonicalV20092IntegrationStorageTarget(selected, "integration", {
        ...options,
        reader: { read: async () => ({ ...state(92), shape: "[]\n" }) },
      }),
    ).rejects.toThrow("schema");
  });

  const statusInvocation = {
    action: "status",
    environment: "integration",
    commit,
    throughMigration: "0092",
  } as const;
  const statusOptions = () => ({
    productionD1,
    integrationStorageIdentityProvider: identityProvider,
    reader: { read: async () => state(88) },
    schemaV20092WalletProof: async () => proof(),
    cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "fixture-token" },
  });
  const ownerProof = async (input: CanonicalV20092OwnerProofInput) => ({
    kind: "takoserver.canonical-v2-0092-owner-proof@v1" as const,
    phase: input.phase,
    accountId: input.target.accountId,
    databaseId: input.target.d1.databaseId,
    databaseName: input.target.d1.databaseName,
    publicCommit: input.publicCommit,
    sourceDigest: input.sourceDigest,
    applied: input.applied,
    schemaShapeDigest: input.schemaShapeDigest,
    expectedPostApplied: input.expectedPostApplied,
    retainedNativeClaimDigest: `sha256:${"b".repeat(64)}`,
    dependencyProofDigest: `sha256:${"c".repeat(64)}`,
    unresolvedAttemptCount: 0 as const,
  });
  const custody = {
    async persistDispatched(binding: CanonicalV20092DispatchBinding) {
      return {
        kind: "takoserver.canonical-v2-0092-custody-receipt@v1" as const,
        state: "dispatched" as const,
        bindingDigest: canonicalV20092DispatchBindingDigest(binding),
        custodyDigest: `sha256:${"f".repeat(64)}`,
      };
    },
    async reconcilePost(binding: CanonicalV20092DispatchBinding) {
      return {
        kind: "takoserver.canonical-v2-0092-custody-receipt@v1" as const,
        state: "terminal" as const,
        bindingDigest: canonicalV20092DispatchBindingDigest(binding),
        custodyDigest: `sha256:${"f".repeat(64)}`,
      };
    },
  };

  test("0092 status selects only the exact 0088 origin", async () => {
    const options = statusOptions();
    const status = await runD1Schema(statusInvocation, target, options);
    expect(status).toMatchObject({
      fromMigration: "0088_v2_worker_sqlite_external_drain.sql",
      throughMigration: "0092_org_wallet_lifecycle.sql",
      pendingMigrations: source.names.slice(88),
      readyForApply: false,
      schemaV20092: {
        qualified: true,
        ownerQualified: false,
        productionD1Guard: "distinct-exact-identity",
      },
    });
  });

  test("0092 direct apply lacks private owner proof", async () => {
    const options = statusOptions();
    await expect(
      runD1Schema({ ...statusInvocation, action: "apply" }, target, options),
    ).rejects.toThrow("owner-injected canonical dependency");
  });

  test("0092 status refuses apply readiness without dispatched custody", async () => {
    const options = statusOptions();
    expect(
      await runD1Schema(statusInvocation, target, {
        ...options,
        canonicalV20092OwnerProof: ownerProof,
      }),
    ).toMatchObject({
      readyForApply: false,
      schemaV20092: { ownerQualified: true, custodyConfigured: false },
    });
  });

  test("0092 status reports readiness only with owner proof and custody", async () => {
    const options = statusOptions();
    expect(
      await runD1Schema(statusInvocation, target, {
        ...options,
        canonicalV20092OwnerProof: ownerProof,
        canonicalV20092DispatchCustody: custody,
      }),
    ).toMatchObject({ readyForApply: true });
  });

  test("0092 owner proof rejects unresolved private attempts", async () => {
    await expect(
      runD1Schema(statusInvocation, target, {
        ...statusOptions(),
        canonicalV20092OwnerProof: async (input) => ({
          ...(await ownerProof(input)),
          unresolvedAttemptCount: 1 as never,
        }),
      }),
    ).rejects.toThrow("terminal attempts");
  });

  for (const native of ["production-descriptor", "d1-get", "r2-get"] as const) {
    test(`0092 native identity refuses ${native} mismatch`, async () => {
      const options = statusOptions();
      if (native === "production-descriptor") {
        await expect(
          runD1Schema(statusInvocation, target, { ...options, productionD1: target.d1 }),
        ).rejects.toThrow("distinct read-only production");
      } else if (native === "d1-get") {
        await expect(
          runD1Schema(statusInvocation, target, {
            ...options,
            integrationStorageIdentityProvider: {
              ...identityProvider,
              async getD1(databaseId: string) {
                return { uuid: databaseId, name: productionD1.databaseName };
              },
            },
          }),
        ).rejects.toThrow("provider identity differs");
      } else {
        await expect(
          runD1Schema(statusInvocation, target, {
            ...options,
            integrationStorageIdentityProvider: {
              ...identityProvider,
              async getR2(_name: string) {
                return { name: "stale-r2" };
              },
            },
          }),
        ).rejects.toThrow("provider identity differs");
      }
    });
  }

  for (const invalid of ["premature-92", "production", "wrong-origin", "wrong-name"] as const) {
    test(`0092 staging selector refuses ${invalid}`, async () => {
      const selected =
        invalid === "premature-92"
          ? {
              ...target,
              takoformV2: { ...target.takoformV2, appliedSchemaLineage: "v2-0092" as const },
            }
          : invalid === "production"
            ? { ...target, environment: "production" as const }
            : invalid === "wrong-origin"
              ? {
                  ...target,
                  takoformV2: { ...target.takoformV2, storageLineage: "v2-0091" as const },
                }
              : { ...target, d1: { ...target.d1, databaseName: productionD1.databaseName } };
      const result = runD1Schema(statusInvocation, selected, statusOptions());
      if (invalid === "production") await expect(result).rejects.toThrow();
      else
        await expect(result).rejects.toThrow(
          invalid === "premature-92"
            ? "cannot precede its exact D1 readback"
            : "generated integration",
        );
    });
  }

  for (const count of [89, 90, 91] as const) {
    test(`0092 status refuses partial applied lineage ${count}`, async () => {
      await expect(
        runD1Schema(statusInvocation, target, {
          ...statusOptions(),
          reader: { read: async () => state(count) },
        }),
      ).rejects.toThrow("partial lineage");
    });
  }

  test("0092 status refuses noncanonical exact 0088 shape", async () => {
    await expect(
      runD1Schema(statusInvocation, target, {
        ...statusOptions(),
        reader: { read: async () => ({ ...state(88), shape: "[]\n" }) },
      }),
    ).rejects.toThrow("canonical exact 0088");
  });

  test("local 0092 backfill preserves money rows and rejects post-readback drift", async () => {
    const db = new Database(":memory:");
    try {
      db.exec("PRAGMA foreign_keys=ON");
      for (const file of source.files.slice(0, 88)) db.exec(readFileSync(file.path, "utf8"));
      db.exec(
        "INSERT INTO ledger(id,org_id,type,ref,settled_delta,held_delta,created_at) VALUES ('l1','org_a','funding','funding:a',500,0,'2026-10-13T00:00:00Z')",
      );
      db.exec(
        "INSERT INTO wallet_credit_lots(org_id,ref,kind,amount_minor,expires_at,created_at) VALUES ('org_a','funding:a','purchased',500,NULL,'2026-10-13T00:00:00Z')",
      );
      const remote = {
        async query(_phase: unknown, _description: unknown, sql: string) {
          return db.query(sql).all() as Record<string, unknown>[];
        },
      };
      const before = await inspectSchemaV20092WalletProof(remote, "preflight", 88);
      db.exec("CREATE TABLE d1_migrations (name TEXT UNIQUE NOT NULL)");
      const importSql = buildD1MigrationImport(source.files.slice(88), { freshLedger: false }).sql;
      expect(() =>
        db.transaction(() => db.exec(`${importSql}\nINSERT INTO missing_0092_abort VALUES (1);`))(),
      ).toThrow();
      expect(db.query("SELECT COUNT(*) AS rows FROM d1_migrations").get()).toMatchObject({
        rows: 0,
      });
      expect(
        db
          .query(
            "SELECT COUNT(*) AS rows FROM pragma_table_info('wallet_credit_lots') WHERE name='cursor_handle'",
          )
          .get(),
      ).toMatchObject({ rows: 0 });
      expect(await inspectSchemaV20092WalletProof(remote, "preflight", 88)).toEqual(before);
      for (const file of source.files.slice(88)) db.exec(readFileSync(file.path, "utf8"));
      const after = await inspectSchemaV20092WalletProof(remote, "verification", 92);
      expect(() => assertSchemaV20092PostProof(before, after)).not.toThrow();
      expect(db.query("SELECT cursor_handle FROM wallet_credit_lots").get()).toMatchObject({
        cursor_handle: expect.any(String),
      });
      db.exec("UPDATE ledger SET settled_delta=499 WHERE id='l1'");
      const drift = await inspectSchemaV20092WalletProof(remote, "verification", 92);
      expect(() => assertSchemaV20092PostProof(before, drift)).toThrow("preservation");
    } finally {
      db.close();
    }
  });

  test("bounded protected-row proof rejects overflow and silently truncated reads", async () => {
    const overflow = {
      async query() {
        return [{ rows: 1001 }];
      },
    };
    await expect(inspectSchemaV20092WalletProof(overflow, "preflight", 88)).rejects.toThrow(
      "1000-row staging proof bound",
    );
    const truncated = {
      async query(_phase: unknown, _description: unknown, sql: string) {
        return sql.startsWith("SELECT COUNT(*)") ? [{ rows: 2 }] : [{ id: "first" }];
      },
    };
    await expect(inspectSchemaV20092WalletProof(truncated, "preflight", 88)).rejects.toThrow(
      "truncated or changed",
    );
    const unsafe = {
      async query() {
        return [{ rows: Number.MAX_SAFE_INTEGER + 1 }];
      },
    };
    await expect(inspectSchemaV20092WalletProof(unsafe, "preflight", 88)).rejects.toThrow(
      "malformed rows count",
    );
  });

  test("one sealed 0089–0092 import settles a lost acknowledgement by exact readback", async () => {
    const root = mkdtempSync(join(tmpdir(), "takoserver-schema-0092-"));
    let applied = 88;
    let imports = 0;
    let dispatchedDigest: string | null = null;
    const phases: string[] = [];
    const before = proof();
    const after: SchemaV20092WalletProof = {
      ...before,
      invalidCursorCount: 0,
      newTableRows: {
        stripe_events: 0,
        org_wallet_holds: 0,
        org_wallet_usage_records: 0,
        org_wallet_grant_snapshots: 0,
        org_wallet_pricing_revisions: 0,
        org_wallet_monthly_tariffs: 0,
      },
    };
    const ownerProof = async (input: CanonicalV20092OwnerProofInput) => {
      phases.push(`${input.phase}:${input.applied.length}`);
      return {
        kind: "takoserver.canonical-v2-0092-owner-proof@v1" as const,
        phase: input.phase,
        accountId: input.target.accountId,
        databaseId: input.target.d1.databaseId,
        databaseName: input.target.d1.databaseName,
        publicCommit: input.publicCommit,
        sourceDigest: input.sourceDigest,
        applied: input.applied,
        schemaShapeDigest: input.schemaShapeDigest,
        expectedPostApplied: input.expectedPostApplied,
        retainedNativeClaimDigest: `sha256:${"d".repeat(64)}`,
        dependencyProofDigest: `sha256:${(input.applied.length === 88 ? "e" : "f").repeat(64)}`,
        unresolvedAttemptCount: 0 as const,
      };
    };
    const ok = (stdout = "") => ({ exitCode: 0, stdout, stderr: "" });
    const run: SchemaProcess = async (command) => {
      const key = command.join(" ");
      if (key === "git rev-parse HEAD") return ok(commit);
      if (key === "git branch --show-current") return ok("feature/schema-0092");
      if (key === "git status --porcelain=v1 -z --untracked-files=all") return ok();
      if (key === "git fetch --quiet --all --prune") return ok();
      if (key === `git branch -r --contains ${commit}`) return ok("  origin/feature/schema-0092\n");
      if (
        key === "bun test tests/deploy-schema-v2-0092.test.ts" ||
        key === "bun run check:migrations"
      )
        return ok("green");
      if (command.includes("--file")) {
        imports++;
        const path = command[command.indexOf("--file") + 1] as string;
        const sql = readFileSync(path, "utf8");
        expect(sql).toContain("0089_v2_worker_cron_match_guard_depth.sql");
        expect(sql).toContain("0092_org_wallet_lifecycle.sql");
        expect((sql.match(/INSERT INTO "d1_migrations"/gu) ?? []).length).toBe(4);
        applied = 92;
        return { exitCode: 1, stdout: "", stderr: "lost acknowledgement" };
      }
      throw new Error(`unexpected command: ${key}`);
    };
    const options = {
      run,
      outputDirectory: join(root, "proof"),
      leaseRoot: join(root, "leases"),
      review: "independent-reviewer",
      productionD1,
      integrationStorageIdentityProvider: identityProvider,
      cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "fixture-token" },
      reader: {
        async read() {
          return state(applied);
        },
      },
      schemaV20092WalletProof: async (_phase: unknown, count: 88 | 92) =>
        count === 88 ? before : after,
      canonicalV20092OwnerProof: ownerProof,
      canonicalV20092DispatchCustody: {
        async persistDispatched(binding: CanonicalV20092DispatchBinding) {
          if (dispatchedDigest !== null)
            throw new Error("existing dispatched custody refuses replay");
          dispatchedDigest = canonicalV20092DispatchBindingDigest(binding);
          return {
            kind: "takoserver.canonical-v2-0092-custody-receipt@v1" as const,
            state: "dispatched" as const,
            bindingDigest: dispatchedDigest,
            custodyDigest: `sha256:${"b".repeat(64)}`,
          };
        },
        async reconcilePost(binding: CanonicalV20092DispatchBinding) {
          if (dispatchedDigest === null) throw new Error("missing dispatched custody");
          expect(canonicalV20092DispatchBindingDigest(binding)).toBe(dispatchedDigest);
          return {
            kind: "takoserver.canonical-v2-0092-custody-receipt@v1" as const,
            state: "terminal" as const,
            bindingDigest: dispatchedDigest,
            custodyDigest: `sha256:${"c".repeat(64)}`,
          };
        },
      },
    };
    try {
      const result = await runD1Schema(
        { action: "apply", environment: "integration", commit, throughMigration: "0092" },
        target,
        options,
      );
      expect(result).toMatchObject({
        providerAcknowledgement: "provider-error-recovered-by-authoritative-readback",
        appliedMigrations: source.names,
      });
      expect(imports).toBe(1);
      expect(dispatchedDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
      expect(phases).toContain("mutation:88");
      expect(phases).toContain("verification:92");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a prior dispatched custody refuses a fresh apply before any D1 import", async () => {
    const root = mkdtempSync(join(tmpdir(), "takoserver-schema-0092-existing-custody-"));
    let imports = 0;
    const ok = (stdout = "") => ({ exitCode: 0, stdout, stderr: "" });
    const run: SchemaProcess = async (command) => {
      const key = command.join(" ");
      if (key === "git rev-parse HEAD") return ok(commit);
      if (key === "git branch --show-current") return ok("feature/schema-0092");
      if (key === "git status --porcelain=v1 -z --untracked-files=all") return ok();
      if (key === "git fetch --quiet --all --prune") return ok();
      if (key === `git branch -r --contains ${commit}`) return ok("  origin/feature/schema-0092\n");
      if (
        key === "bun test tests/deploy-schema-v2-0092.test.ts" ||
        key === "bun run check:migrations"
      )
        return ok("green");
      if (command.includes("--file")) {
        imports++;
        return ok();
      }
      throw new Error(`unexpected command: ${key}`);
    };
    try {
      await expect(
        runD1Schema({ ...statusInvocation, action: "apply" }, target, {
          ...statusOptions(),
          run,
          outputDirectory: join(root, "proof"),
          leaseRoot: join(root, "leases"),
          review: "independent-reviewer",
          canonicalV20092OwnerProof: ownerProof,
          canonicalV20092DispatchCustody: {
            async persistDispatched() {
              throw new Error("existing dispatched attempt refuses resend");
            },
            async reconcilePost() {
              throw new Error("not reached");
            },
          },
        }),
      ).rejects.toThrow("existing dispatched attempt refuses resend");
      expect(imports).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  for (const acknowledgement of ["unknown", "acknowledged"] as const) {
    test(`${acknowledgement} acknowledgement at 0088 leaves durable dispatch and cannot resend`, async () => {
      const root = mkdtempSync(join(tmpdir(), "takoserver-schema-0092-unknown-"));
      let imports = 0;
      let dispatched = false;
      const ok = (stdout = "") => ({ exitCode: 0, stdout, stderr: "" });
      const run: SchemaProcess = async (command) => {
        const key = command.join(" ");
        if (key === "git rev-parse HEAD") return ok(commit);
        if (key === "git branch --show-current") return ok("feature/schema-0092");
        if (key === "git status --porcelain=v1 -z --untracked-files=all") return ok();
        if (key === "git fetch --quiet --all --prune") return ok();
        if (key === `git branch -r --contains ${commit}`)
          return ok("  origin/feature/schema-0092\n");
        if (
          key === "bun test tests/deploy-schema-v2-0092.test.ts" ||
          key === "bun run check:migrations"
        )
          return ok("green");
        if (command.includes("--file")) {
          imports++;
          return acknowledgement === "acknowledged"
            ? ok()
            : { exitCode: 1, stdout: "", stderr: "transport outcome unknown" };
        }
        throw new Error(`unexpected command: ${key}`);
      };
      const ownerProof = async (input: CanonicalV20092OwnerProofInput) => ({
        kind: "takoserver.canonical-v2-0092-owner-proof@v1" as const,
        phase: input.phase,
        accountId: input.target.accountId,
        databaseId: input.target.d1.databaseId,
        databaseName: input.target.d1.databaseName,
        publicCommit: input.publicCommit,
        sourceDigest: input.sourceDigest,
        applied: input.applied,
        schemaShapeDigest: input.schemaShapeDigest,
        expectedPostApplied: input.expectedPostApplied,
        retainedNativeClaimDigest: `sha256:${"d".repeat(64)}`,
        dependencyProofDigest: `sha256:${"e".repeat(64)}`,
        unresolvedAttemptCount: 0 as const,
      });
      const options = {
        run,
        leaseRoot: join(root, "leases"),
        review: "independent-reviewer",
        productionD1,
        integrationStorageIdentityProvider: identityProvider,
        cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "fixture-token" },
        reader: {
          async read() {
            return state(88);
          },
        },
        schemaV20092WalletProof: async () => proof(),
        canonicalV20092OwnerProof: ownerProof,
        canonicalV20092DispatchCustody: {
          async persistDispatched(binding: CanonicalV20092DispatchBinding) {
            if (dispatched) throw new Error("existing dispatched attempt refuses resend");
            dispatched = true;
            return {
              kind: "takoserver.canonical-v2-0092-custody-receipt@v1" as const,
              state: "dispatched" as const,
              bindingDigest: canonicalV20092DispatchBindingDigest(binding),
              custodyDigest: `sha256:${"a".repeat(64)}`,
            };
          },
          async reconcilePost() {
            throw new Error("0088 cannot terminalize custody");
          },
        },
      };
      try {
        const invocation = {
          action: "apply",
          environment: "integration",
          commit,
          throughMigration: "0092",
        } as const;
        await expect(
          runD1Schema(invocation, target, { ...options, outputDirectory: join(root, "first") }),
        ).rejects.toThrow(
          acknowledgement === "acknowledged"
            ? "not the exact complete lineage"
            : "GET-only recovery",
        );
        expect(dispatched).toBe(true);
        expect(imports).toBe(1);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }

  test("custody callback cannot change sealed import after dispatch without stopping remote execution", async () => {
    const root = mkdtempSync(join(tmpdir(), "takoserver-schema-0092-tamper-"));
    let imports = 0;
    let dispatched = false;
    const ok = (stdout = "") => ({ exitCode: 0, stdout, stderr: "" });
    const run: SchemaProcess = async (command) => {
      const key = command.join(" ");
      if (key === "git rev-parse HEAD") return ok(commit);
      if (key === "git branch --show-current") return ok("feature/schema-0092");
      if (key === "git status --porcelain=v1 -z --untracked-files=all") return ok();
      if (key === "git fetch --quiet --all --prune") return ok();
      if (key === `git branch -r --contains ${commit}`) return ok("  origin/feature/schema-0092\n");
      if (
        key === "bun test tests/deploy-schema-v2-0092.test.ts" ||
        key === "bun run check:migrations"
      )
        return ok("green");
      if (command.includes("--file")) {
        imports++;
        return ok();
      }
      throw new Error(`unexpected command: ${key}`);
    };
    const ownerProof = async (input: CanonicalV20092OwnerProofInput) => ({
      kind: "takoserver.canonical-v2-0092-owner-proof@v1" as const,
      phase: input.phase,
      accountId: input.target.accountId,
      databaseId: input.target.d1.databaseId,
      databaseName: input.target.d1.databaseName,
      publicCommit: input.publicCommit,
      sourceDigest: input.sourceDigest,
      applied: input.applied,
      schemaShapeDigest: input.schemaShapeDigest,
      expectedPostApplied: input.expectedPostApplied,
      retainedNativeClaimDigest: `sha256:${"d".repeat(64)}`,
      dependencyProofDigest: `sha256:${"e".repeat(64)}`,
      unresolvedAttemptCount: 0 as const,
    });
    const options = {
      run,
      leaseRoot: join(root, "leases"),
      review: "independent-reviewer",
      productionD1,
      integrationStorageIdentityProvider: identityProvider,
      cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "fixture-token" },
      reader: {
        async read() {
          return state(88);
        },
      },
      schemaV20092WalletProof: async () => proof(),
      canonicalV20092OwnerProof: ownerProof,
      canonicalV20092DispatchCustody: {
        async persistDispatched(binding: CanonicalV20092DispatchBinding) {
          if (dispatched) throw new Error("dispatched custody blocks retry");
          dispatched = true;
          const sealedSql = join(root, "first", "release", "migration-import.sql");
          chmodSync(sealedSql, 0o600);
          appendFileSync(sealedSql, "\n-- attempted post-seal mutation\n");
          return {
            kind: "takoserver.canonical-v2-0092-custody-receipt@v1" as const,
            state: "dispatched" as const,
            bindingDigest: canonicalV20092DispatchBindingDigest(binding),
            custodyDigest: `sha256:${"a".repeat(64)}`,
          };
        },
        async reconcilePost() {
          throw new Error("not reached");
        },
      },
    };
    try {
      const invocation = {
        action: "apply",
        environment: "integration",
        commit,
        throughMigration: "0092",
      } as const;
      await expect(
        runD1Schema(invocation, target, { ...options, outputDirectory: join(root, "first") }),
      ).rejects.toThrow("artifact changed after it was sealed");
      expect(dispatched).toBe(true);
      expect(imports).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
