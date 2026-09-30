import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSelfhostFormAdmission } from "../scripts/selfhost-form-admission.ts";
import { MIGRATIONS } from "../src/db-schema.ts";
import { buildEdgeForms } from "../src/edge-forms.ts";
import { canonicalDigest } from "../src/json.ts";
import { createFileObjectStore } from "../src/objects-fs.ts";
import type { Provider } from "../src/provider-port.ts";
import { deriveRuntimeImplementationCatalog } from "../src/public-worker-implementation.ts";
import { SELFHOST_IDENTITY_CAPABILITY_KINDS } from "../src/selfhost-composition.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import { createStandaloneProviderComposition } from "../src/standalone-provider-composition.ts";
import { createTakoformArtifacts } from "../src/takoform/artifacts.ts";
import { currentTakoformCandidates } from "../src/takoform/current-candidates.ts";
import { yurucommuLifecycleCapabilityManifest } from "../src/takoform/implementation-catalog.ts";
import { createWorkerdRuntime } from "../src/workerd-runtime.ts";
import { createSyntheticPublisherSetVerifier } from "./helpers/synthetic-publisher-set-verifier.ts";

const SELFHOST_CAPABILITIES = yurucommuLifecycleCapabilityManifest(
  SELFHOST_IDENTITY_CAPABILITY_KINDS,
);
const SELFHOST_IMPLEMENTATION_PAYLOAD_DIGEST = await canonicalDigest({
  kind: "takoserver.selfhost-form-implementation@v1",
  capabilities: SELFHOST_CAPABILITIES,
});
const SELFHOST_CATALOG = await deriveRuntimeImplementationCatalog({
  implementationPayloadDigest: SELFHOST_IMPLEMENTATION_PAYLOAD_DIGEST,
  capabilities: SELFHOST_CAPABILITIES,
});
const PACKAGE_COUNT = 17;
const IMPLEMENTED = SELFHOST_CATALOG.entries.length;

describe("self-host Form admission CLI", () => {
  test("refuses recovery-only mode before opening admission state", async () => {
    const root = mkdtempSync(join(tmpdir(), "tsa-cli-"));
    try {
      const result = await runAdmissionCli(root, {
        TAKOSERVER_RETIRED_PROVIDER_MODE: "cloudflare-object-bucket-drain",
        CLOUDFLARE_ACCOUNT_ID: "fixture-account",
        CLOUDFLARE_API_TOKEN: "fixture-token",
        TAKOSERVER_PROVISIONER_TOKEN: "fixture-provisioner",
      });
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("self-host Form admission requires stable-selfhost");
      expect(existsSync(join(root, "control.sqlite"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("uses the running Host's configured database without opening the default", async () => {
    const root = mkdtempSync(join(tmpdir(), "tsa-cli-"));
    const databasePath = join(root, "custom.sqlite");
    const database = new Database(databasePath);
    for (const migration of MIGRATIONS) database.exec(migration.sql);
    database.close();
    try {
      // The unreachable verifier keeps this a pre-admission probe. The CLI
      // must select the exact Host database before reaching that boundary.
      const result = await runAdmissionCli(root, { TAKOSERVER_DB: databasePath });
      expect(result.exitCode).not.toBe(0);
      expect(existsSync(databasePath)).toBe(true);
      expect(existsSync(join(root, "control.sqlite"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("refuses an ephemeral Host database before opening admission state", async () => {
    const root = mkdtempSync(join(tmpdir(), "tsa-cli-"));
    try {
      const result = await runAdmissionCli(root, { TAKOSERVER_DB: ":memory:" });
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("self-host Form admission requires durable local state");
      expect(existsSync(join(root, "control.sqlite"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

async function runAdmissionCli(root: string, environment: Readonly<Record<string, string>>) {
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      "scripts/selfhost-form-admission.ts",
      "org_cli",
      "default",
      "--data-root",
      root,
      "--core-verifier",
      "http://127.0.0.1:1",
      "--apply",
    ],
    {
      cwd: join(import.meta.dir, ".."),
      env: { PATH: process.env.PATH, HOME: process.env.HOME, ...environment },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [exitCode, stderr] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
    new Response(child.stdout).text(),
  ]);
  return { exitCode, stderr };
}

describe("self-host Form admission", () => {
  test("plans the exact publisher set as a dry run and records nothing", async () => {
    const fixture = dataRoot();
    try {
      const verifier = createSyntheticPublisherSetVerifier();
      const provider = await fixture.provider();
      const result = await runSelfhostFormAdmission({
        organizationId: "org_selfhost",
        space: "default",
        hostId: "http://localhost:8787",
        coreVerifierUrl: "http://127.0.0.1:1",
        apply: false,
        sql: fixture.sql,
        objects: fixture.objects,
        provider,
        fetch: verifier.fetch,
      });
      expect(result.applied).toBeNull();
      expect(result.plan.packages).toHaveLength(PACKAGE_COUNT);
      expect(result.plan.commands).toHaveLength(2 + PACKAGE_COUNT + IMPLEMENTED * 2);
      expect(verifier.calls).toEqual(["/v1/identity"]);
      expect(await fixture.sql.query("SELECT * FROM tf_form_publisher_events")).toEqual([]);
    } finally {
      fixture.close();
    }
    // Inspecting the complete package corpus on a shared runner is not a
    // product latency assertion.
  }, 30_000);

  test("applies admission with synthetic Core responses and activates the implemented subset", async () => {
    const fixture = dataRoot();
    try {
      const verifier = createSyntheticPublisherSetVerifier();
      const provider = await fixture.provider();
      const result = await runSelfhostFormAdmission({
        organizationId: "org_selfhost",
        space: "default",
        hostId: "http://localhost:8787",
        coreVerifierUrl: "http://127.0.0.1:1",
        apply: true,
        sql: fixture.sql,
        objects: fixture.objects,
        provider,
        fetch: verifier.fetch,
      });
      const applied = result.applied;
      if (!applied) throw new Error("apply result is missing");
      expect(applied.status).toBe("converged");
      expect(applied.verificationMode).toBe("released-core");
      expect(verifier.calls).toEqual(["/v1/identity", "/v1/verify-set"]);
      const forms = applied.readback.forms;
      expect(forms.filter((form) => form.installed)).toHaveLength(PACKAGE_COUNT);
      expect(forms.filter((form) => form.supported)).toHaveLength(IMPLEMENTED);
      expect(forms.filter((form) => form.activationHead.active)).toHaveLength(IMPLEMENTED);
      // ADR 0007: an identity Form is admitted with the operations its Form
      // declares on a Host that realizes its supply, and with an EMPTY set on
      // one that does not. A self-host realizes the ObjectBucket supply now —
      // object bodies under its data root, metadata in its control database,
      // and a Provider Pack owning both halves of the object Binding — so the
      // Form is admitted with the five operations it declares and never with
      // `update`, which it does not declare however wide the other sets are.
      expect(forms.find((form) => form.formRef.kind === "ObjectBucket")).toMatchObject({
        installed: true,
        supported: true,
        operations: ["create", "read", "delete", "import", "observe"],
        activationHead: { present: true, active: true },
      });
      // Every other supported Form still carries the operations it declares.
      expect(forms.find((form) => form.formRef.kind === "EdgeKVNamespace")?.operations).toEqual([
        "create",
        "read",
        "delete",
        "import",
        "observe",
      ]);
      for (const kind of ["ActorNamespace", "DurableWorkflow"]) {
        expect(forms.find((form) => form.formRef.kind === kind)).toMatchObject({
          installed: true,
          supported: false,
          activationHead: { present: false, active: false },
        });
      }
      expect(await fixture.sql.query("SELECT count(*) AS c FROM tf_form_install_events")).toEqual([
        { c: 17 },
      ]);

      const again = await runSelfhostFormAdmission({
        organizationId: "org_selfhost",
        space: "default",
        hostId: "http://localhost:8787",
        coreVerifierUrl: "http://127.0.0.1:1",
        apply: true,
        sql: fixture.sql,
        objects: fixture.objects,
        provider,
        fetch: verifier.fetch,
      });
      expect(again.plan.commands).toEqual([]);
      expect(again.applied?.status).toBe("converged");
    } finally {
      fixture.close();
    }
    // Two full 17-package admissions include filesystem-backed object writes
    // and readbacks, so retain a bounded integration-test budget.
  }, 60_000);

  test("refuses a verifier whose live identity is not the exact released Core", async () => {
    const fixture = dataRoot();
    try {
      const verifier = createSyntheticPublisherSetVerifier({
        artifactDigest: `sha256:${"b".repeat(64)}`,
      });
      const provider = await fixture.provider();
      await expect(
        runSelfhostFormAdmission({
          organizationId: "org_selfhost",
          space: "default",
          hostId: "http://localhost:8787",
          coreVerifierUrl: "http://127.0.0.1:1",
          apply: true,
          sql: fixture.sql,
          objects: fixture.objects,
          provider,
          fetch: verifier.fetch,
        }),
      ).rejects.toMatchObject({ code: "artifact_mismatch" });
      expect(await fixture.sql.query("SELECT * FROM tf_form_publisher_events")).toEqual([]);
    } finally {
      fixture.close();
    }
  });

  test("derives admission import support from the supplied Provider handler", async () => {
    const fixture = dataRoot();
    try {
      const verifier = createSyntheticPublisherSetVerifier();
      const provider = await fixture.provider();
      // This alters only one lifecycle handler on a real composed Provider;
      // admission identity must track that method surface rather than any
      // separately declared runtime/native availability.
      const withoutAdopt: Provider = Object.assign(Object.create(provider) as Provider, {
        adopt: undefined,
      });
      const result = await runSelfhostFormAdmission({
        organizationId: "org_selfhost",
        space: "default",
        hostId: "http://localhost:8787",
        coreVerifierUrl: "http://127.0.0.1:1",
        apply: false,
        sql: fixture.sql,
        objects: fixture.objects,
        provider: withoutAdopt,
        fetch: verifier.fetch,
      });
      const edgeKv = result.plan.packages.find((entry) => entry.formRef.kind === "EdgeKVNamespace");
      expect(edgeKv?.operations).toEqual(["create", "read", "delete", "observe"]);
    } finally {
      fixture.close();
    }
  });
});

function dataRoot() {
  const root = mkdtempSync(join(tmpdir(), "takoserver-selfhost-admission-"));
  const objects = createFileObjectStore({ root });
  // These cases receive an SQL handle and never reopen a database file. Keep
  // the full SQLite schema and constraints without per-migration disk flushes;
  // the assertions cover admission authority/state, not filesystem durability.
  const database = new Database(":memory:");
  for (const migration of MIGRATIONS) database.exec(migration.sql);
  return {
    root,
    sql: createSqliteSql(database),
    objects,
    async provider() {
      const artifacts = createTakoformArtifacts({
        sql: createSqliteSql(database),
        objects,
        clock: () => new Date(),
        randomId: () => crypto.randomUUID(),
      });
      const composition = createStandaloneProviderComposition({
        mode: "stable-selfhost",
        stableForms: currentTakoformCandidates().forms,
        edge: await buildEdgeForms(),
        dataRoot: root,
        runtime: createWorkerdRuntime({ root, binary: null }),
        // These admission tests inspect the concrete Provider method surface,
        // not native workerd qualification or runtime service availability.
        workerRuntimeAvailable: false,
        artifacts: {
          manifest: (tenantRef, digest) => artifacts.resolveManifest(tenantRef, digest),
          async blob(digest) {
            const object = await objects.get(`art/${digest.slice("sha256:".length)}`);
            return object ? new Uint8Array(await new Response(object.body).arrayBuffer()) : null;
          },
        },
        now: new Date(),
      });
      const provider = composition.providers[0];
      if (!provider) throw new Error("self-host provider composition is empty");
      return provider;
    },
    close() {
      database.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
