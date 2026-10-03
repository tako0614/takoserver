import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSelfhostFormAdmission } from "../scripts/selfhost-form-admission.ts";
import { createActorResourceGraphReader } from "../src/actor-resource-graph.ts";
import { createAppResourceStoreBundle } from "../src/app.ts";
import { MIGRATIONS } from "../src/db-schema.ts";
import { buildEdgeForms } from "../src/edge-forms.ts";
import { canonicalDigest, canonicalJson } from "../src/json.ts";
import { createFileObjectStore } from "../src/objects-fs.ts";
import type { Provider } from "../src/provider-port.ts";
import { SELFHOST_ACTOR_BINDING_REF } from "../src/providers/selfhost.ts";
import { deriveRuntimeImplementationCatalog } from "../src/public-worker-implementation.ts";
import {
  openSelfhostActorPublicRuntime,
  type SelfhostActorPublicRuntime,
} from "../src/selfhost-actor-public-runtime.ts";
import {
  hasExactSelfhostActorClosure,
  SELFHOST_IDENTITY_CAPABILITY_KINDS,
} from "../src/selfhost-composition.ts";
import { deriveSelfhostFormAuthorityCatalog } from "../src/selfhost-form-authority-composition.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import { createStandaloneProviderComposition } from "../src/standalone-provider-composition.ts";
import { createTakoformArtifacts } from "../src/takoform/artifacts.ts";
import { currentTakoformCandidates } from "../src/takoform/current-candidates.ts";
import {
  selfhostLifecycleCapabilityManifest,
  yurucommuLifecycleCapabilityManifest,
} from "../src/takoform/implementation-catalog.ts";
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

  test("reopens partial admission across CLI processes without duplicate events", async () => {
    const root = mkdtempSync(join(tmpdir(), "tsa-cli-reopen-"));
    // This loopback fixture replays synthetic verifier responses; it exercises
    // durable CLI recovery, not released-Core or publisher-trust qualification.
    const verifier = createSyntheticPublisherSetVerifier();
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) => verifier.fetch(request),
    });
    try {
      const lastActivated = [...SELFHOST_CATALOG.entries]
        .sort((left, right) =>
          canonicalJson(left.formRef).localeCompare(canonicalJson(right.formRef)),
        )
        .at(-1);
      if (!lastActivated) throw new Error("self-host implementation catalog is empty");
      const targetRefJson = canonicalJson(lastActivated.formRef);
      const quoteSql = (value: string) => value.replaceAll("'", "''");
      const databasePath = join(root, "control.sqlite");
      const seed = new Database(databasePath);
      try {
        for (const migration of MIGRATIONS) seed.exec(migration.sql);
        seed.exec(
          `CREATE TRIGGER fail_last_selfhost_activation
           BEFORE INSERT ON tf_form_activation_events
           WHEN NEW.form_ref_json = '${quoteSql(targetRefJson)}' AND NEW.active = 1
           BEGIN SELECT RAISE(ABORT, 'synthetic late activation failure'); END`,
        );
      } finally {
        seed.close();
      }

      const verifierUrl = `http://127.0.0.1:${server.port}`;
      const failed = await runAdmissionCli(root, {}, verifierUrl);
      expect(failed.exitCode).not.toBe(0);
      expect(failed.stdout).toContain("apply: partial");
      expect(failed.stdout).toContain("failure at command");
      expect(failed.stdout).toContain(
        `installed ${PACKAGE_COUNT}, supported ${IMPLEMENTED}, active ${IMPLEMENTED - 1}`,
      );
      expect(failed.stdout).toContain("inspect persisted state and re-run this command to re-plan");

      const installedBeforeRetry = currentTakoformCandidates().forms.filter(
        (form) => canonicalJson(form.identity.formRef).localeCompare(targetRefJson) <= 0,
      ).length;
      const partial = new Database(databasePath);
      try {
        expect(countRows(partial, "tf_form_install_events")).toBe(installedBeforeRetry);
        expect(countDistinctFormRefs(partial, "tf_form_install_events")).toBe(installedBeforeRetry);
        expect(countRows(partial, "tf_form_support_events")).toBe(IMPLEMENTED);
        expect(countDistinctFormRefs(partial, "tf_form_support_events")).toBe(IMPLEMENTED);
        expect(countRows(partial, "tf_form_activation_events")).toBe(IMPLEMENTED - 1);
        expect(countDistinctFormRefs(partial, "tf_form_activation_events")).toBe(IMPLEMENTED - 1);
        expect(countRows(partial, "tf_form_activation_events", "active = 1")).toBe(IMPLEMENTED - 1);
        expect(
          partial
            .query(
              "SELECT count(*) AS count FROM tf_form_activation_events WHERE form_ref_json = ?",
            )
            .get(targetRefJson),
        ).toEqual({ count: 0 });
        partial.exec("DROP TRIGGER fail_last_selfhost_activation");
      } finally {
        partial.close();
      }

      const reopened = await runAdmissionCli(root, {}, verifierUrl);
      expect(reopened.exitCode).toBe(0);
      expect(reopened.stdout).toContain("apply: converged");
      expect(reopened.stdout).toContain(`installed ${PACKAGE_COUNT}, supported ${IMPLEMENTED}`);
      expect(reopened.stdout).toContain(`active ${IMPLEMENTED}`);
      const converged = new Database(databasePath);
      try {
        expect(countRows(converged, "tf_form_install_events")).toBe(PACKAGE_COUNT);
        expect(countDistinctFormRefs(converged, "tf_form_install_events")).toBe(PACKAGE_COUNT);
        expect(countRows(converged, "tf_form_support_events")).toBe(IMPLEMENTED);
        expect(countDistinctFormRefs(converged, "tf_form_support_events")).toBe(IMPLEMENTED);
        expect(countRows(converged, "tf_form_activation_events")).toBe(IMPLEMENTED);
        expect(countDistinctFormRefs(converged, "tf_form_activation_events")).toBe(IMPLEMENTED);
        expect(countRows(converged, "tf_form_activation_events", "active = 1")).toBe(IMPLEMENTED);
      } finally {
        converged.close();
      }
      expect(verifier.calls).toEqual([
        "/v1/identity",
        "/v1/verify-set",
        "/v1/identity",
        "/v1/verify-set",
      ]);
    } finally {
      server.stop(true);
      rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);
});

async function runAdmissionCli(
  root: string,
  environment: Readonly<Record<string, string>>,
  coreVerifierUrl = "http://127.0.0.1:1",
) {
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      "scripts/selfhost-form-admission.ts",
      "org_cli",
      "default",
      "--data-root",
      root,
      "--host-id",
      "http://localhost:8787",
      "--core-verifier",
      coreVerifierUrl,
      "--apply",
    ],
    {
      cwd: join(import.meta.dir, ".."),
      env: { PATH: process.env.PATH, HOME: process.env.HOME, ...environment },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

function countRows(database: Database, table: string, where?: string): number {
  const result = database
    .query(`SELECT count(*) AS count FROM ${table}${where ? ` WHERE ${where}` : ""}`)
    .get() as { readonly count: number } | null;
  return result?.count ?? 0;
}

function countDistinctFormRefs(database: Database, table: string): number {
  const result = database
    .query(`SELECT count(DISTINCT form_ref_key) AS count FROM ${table}`)
    .get() as { readonly count: number } | null;
  return result?.count ?? 0;
}

describe("self-host Form admission", () => {
  test("a partial released Actor closure selects the base support profile before owner construction", () => {
    const released = currentTakoformCandidates();
    expect(
      hasExactSelfhostActorClosure({
        stableForms: released.forms,
        stableBindings: released.bindings,
      }),
    ).toBe(true);
    expect(
      hasExactSelfhostActorClosure({
        stableForms: released.forms.filter(
          (form) => form.identity.formRef.kind !== "WorkerVersion",
        ),
        stableBindings: released.bindings,
      }),
    ).toBe(false);
    expect(
      hasExactSelfhostActorClosure({
        stableForms: released.forms,
        stableBindings: released.bindings.map((binding) =>
          canonicalJson(binding.bindingRef) === canonicalJson(SELFHOST_ACTOR_BINDING_REF)
            ? {
                ...binding,
                bindingRef: {
                  ...binding.bindingRef,
                  schemaDigest: `sha256:${"0".repeat(64)}` as const,
                },
              }
            : binding,
        ),
      }),
    ).toBe(false);
  });

  test("a restored local Actor owner admits the exact released namespace lifecycle", async () => {
    const fixture = dataRoot();
    let owner: SelfhostActorPublicRuntime | undefined;
    try {
      const candidates = currentTakoformCandidates();
      const actorForm = candidates.forms.find(
        (form) => form.identity.formRef.kind === "ActorNamespace",
      );
      if (!actorForm) throw new Error("released Actor Form missing");
      const stores = createAppResourceStoreBundle(fixture.sql, () => new Date());
      owner = await openSelfhostActorPublicRuntime({
        dataRoot: fixture.root,
        runtimeRoot: fixture.root,
        socketParent: join(fixture.root, "actor-forward-sockets"),
        binary: "/never-execute",
        graph: createActorResourceGraphReader({ store: stores.inventory, form: actorForm }),
        deployments: stores.deployments,
        providerPackRef: "local",
        providerInstallationRef: "local.primary",
      });
      const runtime = createWorkerdRuntime({
        root: fixture.root,
        binary: "/never-execute",
        actorForwardSockets: () => owner?.actorForwardSockets() ?? [],
        actorForwardLifecycle: owner.actorForwardLifecycle,
      });
      const provider = await fixture.provider(owner, runtime);
      const source = {
        provider,
        stableForms: candidates.forms,
        stableBindings: candidates.bindings,
        actorRuntime: owner,
      };
      const capabilities = selfhostLifecycleCapabilityManifest(
        SELFHOST_IDENTITY_CAPABILITY_KINDS,
        actorForm,
      );
      const implementationPayloadDigest = await canonicalDigest({
        kind: "takoserver.selfhost-form-implementation@v1",
        capabilities,
      });
      await expect(
        deriveSelfhostFormAuthorityCatalog({ implementationPayloadDigest, capabilities, source }),
      ).rejects.toMatchObject({ code: "production_not_ready" });
      expect(await runtime.restore()).toEqual([]);
      expect(owner.isRestored()).toBe(true);
      const catalog = await deriveSelfhostFormAuthorityCatalog({
        implementationPayloadDigest,
        capabilities,
        source,
      });
      expect(
        catalog.entries.find((entry) => entry.formRef.kind === "ActorNamespace")?.operations,
      ).toEqual(["create", "read", "delete", "import", "observe"]);
      expect(catalog.capabilityDigest).not.toBe(SELFHOST_CATALOG.capabilityDigest);
      await expect(
        deriveSelfhostFormAuthorityCatalog({
          implementationPayloadDigest,
          capabilities,
          source: { provider, stableForms: candidates.forms, stableBindings: candidates.bindings },
        }),
      ).rejects.toMatchObject({ code: "identity_mismatch" });
      await expect(
        deriveSelfhostFormAuthorityCatalog({
          implementationPayloadDigest,
          capabilities,
          source: {
            ...source,
            stableBindings: candidates.bindings.filter(
              (binding) =>
                canonicalJson(binding.bindingRef) !== canonicalJson(SELFHOST_ACTOR_BINDING_REF),
            ),
          },
        }),
      ).rejects.toMatchObject({ code: "production_not_ready" });
      await expect(
        deriveSelfhostFormAuthorityCatalog({
          implementationPayloadDigest,
          capabilities,
          source: {
            ...source,
            provider: Object.assign(Object.create(provider) as Provider, {
              offerings: provider.offerings.filter(
                (offering) => offering.form.kind !== "ActorNamespace",
              ),
            }),
          },
        }),
      ).rejects.toMatchObject({ code: "production_not_ready" });
      const verifier = createSyntheticPublisherSetVerifier();
      const result = await runSelfhostFormAdmission({
        organizationId: "org_actor_source",
        space: "default",
        hostId: "http://localhost:8787",
        coreVerifierUrl: "http://127.0.0.1:1",
        apply: true,
        sql: fixture.sql,
        objects: fixture.objects,
        provider,
        actorRuntime: owner,
        fetch: verifier.fetch,
      });
      expect(result.applied?.status).toBe("converged");
      expect(
        result.applied?.readback.forms.find((form) => form.formRef.kind === "ActorNamespace"),
      ).toMatchObject({
        installed: true,
        supported: true,
        operations: ["create", "read", "delete", "import", "observe"],
        activationHead: { present: true, active: true },
      });
      const broken = join(fixture.root, "workers", "broken");
      mkdirSync(broken, { recursive: true });
      writeFileSync(join(broken, "takoserver-site.json"), '{"publicationStorageLayout":');
      await expect(runtime.restore()).rejects.toThrow("unusable worker deployment pointer");
      expect(owner.isRestored()).toBe(false);
      await expect(
        deriveSelfhostFormAuthorityCatalog({ implementationPayloadDigest, capabilities, source }),
      ).rejects.toMatchObject({ code: "production_not_ready" });
      expect(await fixture.sql.query("SELECT count(*) AS c FROM tf_form_support_events")).toEqual([
        { c: IMPLEMENTED + 1 },
      ]);
      const contracted = {
        organizationId: "org_actor_source",
        space: "default",
        hostId: "http://localhost:8787",
        coreVerifierUrl: "http://127.0.0.1:1",
        sql: fixture.sql,
        objects: fixture.objects,
        provider,
        fetch: verifier.fetch,
      };
      // Ordinary admission never treats a missing owner as permission to
      // deactivate an already active Form or silently write a new profile.
      await expect(runSelfhostFormAdmission({ ...contracted, apply: true })).rejects.toMatchObject({
        code: "authority_state_conflict",
      });
      expect(
        await fixture.sql.query("SELECT count(*) AS c FROM tf_form_activation_events"),
      ).toEqual([{ c: IMPLEMENTED + 1 }]);
      const dryDeactivation = await runSelfhostFormAdmission({
        ...contracted,
        organizationId: "org_other_source",
        deactivate: true,
        apply: false,
      });
      expect(dryDeactivation.plan.request.activation).toEqual({
        kind: "space",
        tenantId: "org_other_source",
        space: "default",
        desiredActive: false,
      });
      expect(dryDeactivation.applied).toBeNull();
      expect(
        await fixture.sql.query("SELECT count(*) AS c FROM tf_form_activation_events"),
      ).toEqual([{ c: IMPLEMENTED + 1 }]);
      const deactivation = await runSelfhostFormAdmission({
        ...contracted,
        deactivate: true,
        apply: true,
      });
      expect(deactivation.plan.request.activation.desiredActive).toBe(false);
      expect(
        deactivation.applied?.readback.forms.find((form) => form.formRef.kind === "ActorNamespace"),
      ).toMatchObject({ activationHead: { active: false } });
      const repeatedDeactivation = await runSelfhostFormAdmission({
        ...contracted,
        deactivate: true,
        apply: true,
      });
      expect(repeatedDeactivation.plan.commands).toEqual([]);
      // Only after the selected Space is explicitly inactive can a separate
      // ordinary admission re-plan against the narrower base profile.
      const reconverged = await runSelfhostFormAdmission({ ...contracted, apply: true });
      expect(
        reconverged.applied?.readback.forms.find((form) => form.formRef.kind === "ActorNamespace"),
      ).toMatchObject({ installed: true, supported: false, activationHead: { active: false } });
      const repeated = await runSelfhostFormAdmission({ ...contracted, apply: true });
      expect(repeated.plan.commands).toEqual([]);
    } finally {
      await owner?.close();
      fixture.close();
    }
  }, 30_000);
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
    async provider(
      actorRuntime?: SelfhostActorPublicRuntime,
      runtime?: ReturnType<typeof createWorkerdRuntime>,
    ) {
      const artifacts = createTakoformArtifacts({
        sql: createSqliteSql(database),
        objects,
        clock: () => new Date(),
        randomId: () => crypto.randomUUID(),
      });
      const composition = createStandaloneProviderComposition({
        mode: "stable-selfhost",
        stableForms: currentTakoformCandidates().forms,
        stableBindings: currentTakoformCandidates().bindings,
        edge: await buildEdgeForms(),
        dataRoot: root,
        runtime: runtime ?? createWorkerdRuntime({ root, binary: null }),
        ...(actorRuntime ? { actorRuntime } : {}),
        // These admission tests inspect the concrete Provider method surface,
        // not native workerd qualification or runtime service availability.
        workerRuntimeAvailable: actorRuntime !== undefined,
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
