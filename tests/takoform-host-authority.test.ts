import { describe, expect, test } from "bun:test";
import { createEphemeralSql } from "../src/compat.ts";
import { createMemoryObjectStore } from "../src/objects-mem.ts";
import type { JsonObject } from "../src/ports.ts";
import {
  type AdmissionDigest,
  type AdmissionHandleClaims,
  type AdmissionPublisherPin,
  type AdmissionReport,
  createAdmissionHandleIssuer,
  TAKOFORM_REVOCATION_V1,
  TAKOFORM_REVOCATION_V1_EMPTY_ENTRIES_DIGEST,
  TAKOFORM_REVOCATION_V1_GENESIS_DIGEST,
} from "../src/takoform/admission.ts";
import { createFormAdmissionStore } from "../src/takoform/admission-store.ts";
import { currentTakoformCandidates } from "../src/takoform/current-candidates.ts";
import { createFormPackageStore, formPackageKey } from "../src/takoform/form-packages.ts";
import { createTakoformHost } from "../src/takoform/host.ts";
import {
  createTakoformHostAuthority,
  type TakoformAuthorityRequestContext,
  takoformActivationAudience,
} from "../src/takoform/host-authority.ts";
import { InMemoryTakoformResourceDriver } from "../src/takoform/memory-driver.ts";
import { createTakoformStore } from "../src/takoform/store.ts";
import type { TakoformResourceDriver } from "../src/takoform/types.ts";

const CONTEXT: TakoformAuthorityRequestContext = {
  tenantId: "tenant-a",
  principalId: "principal-a",
  space: "main",
};

const technicallyAvailable = {
  async resolve() {
    return { executable: true, activated: true, availableToPrincipal: true };
  },
};

const digest = (hex: string): AdmissionDigest => `sha256:${hex.repeat(64)}` as AdmissionDigest;
const PUBLIC_WORKER_VERSION_ID = "11111111-1111-4111-8111-111111111111";
const STALE_PUBLIC_WORKER_VERSION_ID = "22222222-2222-4222-8222-222222222222";

function first<T>(values: readonly T[], label: string): T {
  const value = values[0];
  if (value === undefined) throw new Error(`${label} missing`);
  return value;
}

function unseeded() {
  const catalog = currentTakoformCandidates();
  const sql = createEphemeralSql();
  const objects = createMemoryObjectStore();
  return {
    catalog,
    sql,
    objects,
    authority: createTakoformHostAuthority({
      sql,
      objects,
      hostId: "host-a",
      candidates: catalog.forms,
      bindings: catalog.bindings,
      technicalAvailability: technicallyAvailable,
    }),
  };
}

async function committedAuthority() {
  const fixture = unseeded();
  const form = first(fixture.catalog.forms, "candidate form");
  const packageDigest = form.identity.packageDigest;
  if (packageDigest === undefined) throw new Error("candidate package digest missing");
  const directory = new URL(
    "./fixtures/takoform-v1/forms/candidates/edge.forms.takoform.com/module-worker/",
    import.meta.url,
  );
  const manifest = (await Bun.file(new URL("package-index.json", directory)).json()) as JsonObject;
  const declarations = manifest.files as readonly {
    readonly path: string;
    readonly digest: `sha256:${string}`;
    readonly mediaType?: string;
  }[];
  const files = await Promise.all(
    declarations.map(async (declaration) => ({
      path: declaration.path,
      digest: declaration.digest,
      ...(declaration.mediaType ? { mediaType: declaration.mediaType } : {}),
      bytes: new Uint8Array(await Bun.file(new URL(declaration.path, directory)).arrayBuffer()),
    })),
  );
  const pkg = {
    packageDigest,
    formRef: form.identity.formRef,
    manifest,
    files,
  };
  const publisher: AdmissionPublisherPin = {
    publisherKey: "publisher-a",
    policyDigest: digest("1"),
    policy: { apiVersion: "policy.forms.takoform.com/v1alpha1", mode: "reviewed" },
    oidcIssuer: "https://issuer.example.test",
    sourceRepository: "https://github.com/example/forms",
    workflow: ".github/workflows/release.yml",
    ref: "refs/tags/v1.0.0",
    identity: "publisher-a",
    trustedRootDigest: digest("2"),
    sourceCommit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    workflowCommit: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    buildConfigCommit: "cccccccccccccccccccccccccccccccccccccccc",
    repositoryIdentifier: "repo:example/forms",
    ownerIdentifier: "owner:example",
    group: "edge.forms.takoform.com",
    namespaceGrantDigest: digest("3"),
  };
  const handles = createAdmissionHandleIssuer();
  const writer = createFormAdmissionStore({
    sql: fixture.sql,
    objects: fixture.objects,
    packages: createFormPackageStore(fixture.objects),
    handles,
  });
  const allow = await writer.execute({
    kind: "AllowPublisher",
    publisher,
    actor: "test-operator",
    reason: "reader fixture",
  });
  const checkpointDigest = TAKOFORM_REVOCATION_V1_GENESIS_DIGEST;
  const entriesDigest = TAKOFORM_REVOCATION_V1_EMPTY_ENTRIES_DIGEST;
  const checkpoint = await writer.execute({
    kind: "AppendCheckpoint",
    publisherKey: "publisher-a",
    checkpointApiVersion: TAKOFORM_REVOCATION_V1,
    policyDigest: publisher.policyDigest,
    policyEventDigest: allow.eventDigest,
    sequence: 0,
    checkpointDigest,
    entriesDigest,
    previousCheckpointDigest: null,
    actor: "test-operator",
    reason: "reader fixture",
  });
  const report: AdmissionReport = {
    status: "admitted",
    operation: "install",
    package: {
      packageDigest: pkg.packageDigest,
      formRef: pkg.formRef,
      fileCount: files.length,
      payloadBytes: files.reduce((total, file) => total + file.bytes.byteLength, 0),
    },
    publisher: {
      policyDigest: publisher.policyDigest,
      oidcIssuer: publisher.oidcIssuer,
      sourceRepository: publisher.sourceRepository,
      workflow: publisher.workflow,
      ref: publisher.ref,
      identity: publisher.identity,
    },
    source: {
      sourceCommit: publisher.sourceCommit,
      workflowCommit: publisher.workflowCommit,
      buildConfigCommit: publisher.buildConfigCommit,
      repositoryIdentifier: publisher.repositoryIdentifier,
      ownerIdentifier: publisher.ownerIdentifier,
    },
    namespace: {
      group: publisher.group,
      namespaceGrantDigest: publisher.namespaceGrantDigest,
    },
    signature: {
      subjectDigest: pkg.packageDigest,
      bundleDigest: allow.eventDigest,
      trustedRootDigest: publisher.trustedRootDigest,
    },
    revocation: {
      checkpointApiVersion: TAKOFORM_REVOCATION_V1,
      sequence: 0,
      checkpointDigest,
      entriesDigest,
      revoked: false,
    },
    checks: [{ code: "reader-fixture", passed: true }],
  };
  const claims: AdmissionHandleClaims = {
    operation: "install",
    packageDigest: pkg.packageDigest,
    formRef: pkg.formRef,
    publisherKey: "publisher-a",
    publisher,
    policyEventDigest: allow.eventDigest,
    checkpointApiVersion: TAKOFORM_REVOCATION_V1,
    checkpointSequence: 0,
    checkpointDigest,
    checkpointEventDigest: checkpoint.eventDigest,
    report,
  };
  const implementationDigest = digest("6");
  await writer.execute({
    kind: "InstallPackage",
    package: pkg,
    handle: handles.issue(claims),
    implementationDigest,
    actor: "test-operator",
    reason: "reader fixture",
  });
  await writer.execute({
    kind: "SetSupport",
    formRef: form.identity.formRef,
    packageDigest: pkg.packageDigest,
    implementationDigest,
    supported: true,
    profile: {
      kind: "takoserver.form-support@v1",
      workerArtifactDigest: digest("7"),
      publicWorkerVersionId: PUBLIC_WORKER_VERSION_ID,
      capabilityDigest: digest("8"),
      implementationDigest,
    },
    operations: ["create", "read", "delete", "observe"],
    actor: "test-operator",
    reason: "reader fixture",
  });
  const audience = takoformActivationAudience("host", { hostId: "host-a" });
  const activation = await writer.execute({
    kind: "SetActivation",
    formRef: form.identity.formRef,
    packageDigest: pkg.packageDigest,
    implementationDigest,
    active: true,
    audience,
    actor: "test-operator",
    reason: "reader fixture",
  });
  return {
    ...fixture,
    form,
    writer,
    packageDigest: pkg.packageDigest,
    implementationDigest,
    audience,
    activation,
    checkpoint,
  };
}

function countingDriver() {
  const memory = new InMemoryTakoformResourceDriver();
  const calls = { apply: 0, observe: 0, delete: 0, import: 0 };
  const driver: TakoformResourceDriver = {
    apply: async (input) => {
      calls.apply += 1;
      return memory.apply(input);
    },
    observe: async (input) => {
      calls.observe += 1;
      return memory.observe(input);
    },
    delete: async (input) => {
      calls.delete += 1;
      return memory.delete(input);
    },
    import: async (input) => {
      calls.import += 1;
      return memory.import(input);
    },
    sqliteMigrations: memory.sqliteMigrations,
  };
  return { calls, driver };
}

function resourceBody(
  formRef: Awaited<ReturnType<typeof committedAuthority>>["form"]["identity"]["formRef"],
  review?: { readonly prepareDigest: string; readonly specDigest?: string },
) {
  return {
    apiVersion: formRef.apiVersion,
    kind: formRef.kind,
    form: { formRef },
    metadata: { name: "worker-a", space: "main" },
    spec: {},
    ...(review ? { review } : {}),
  };
}

async function prepareResource(
  host: ReturnType<typeof createTakoformHost>,
  formRef: Awaited<ReturnType<typeof committedAuthority>>["form"]["identity"]["formRef"],
) {
  const response = await host.handle(
    new Request("https://host.invalid/apis/forms.takoform.com/v1/resources/prepare", {
      method: "POST",
      headers: { authorization: "Bearer test", "content-type": "application/json" },
      body: JSON.stringify(resourceBody(formRef)),
    }),
  );
  expect(response?.status).toBe(200);
  const body = (await response?.json()) as {
    readonly review: { readonly prepareDigest: string; readonly specDigest?: string };
  };
  return body.review;
}

function resourcePath(
  formRef: Awaited<ReturnType<typeof committedAuthority>>["form"]["identity"]["formRef"],
) {
  return `/apis/forms.takoform.com/v1/resources/${formRef.apiVersion}/${formRef.kind}/worker-a`;
}

describe("durable read-only Takoform Host authority", () => {
  test("is unseeded and fails closed even with all 16 byte candidates compiled in", async () => {
    const fixture = unseeded();
    expect(fixture.catalog.forms).toHaveLength(16);

    const discovered = await fixture.authority.catalog(CONTEXT);
    expect(discovered.forms).toEqual([]);
    expect(discovered.bindings).toEqual([]);

    await expect(
      fixture.authority.authorizeMutation({
        operation: "create",
        context: CONTEXT,
        formRef: first(fixture.catalog.forms, "candidate form").identity.formRef,
      }),
    ).rejects.toMatchObject({
      code: "form_unavailable",
      status: 503,
    });
  });

  test("exact package bytes alone do not install, support, or activate a Form", async () => {
    const fixture = unseeded();
    const form = first(fixture.catalog.forms, "candidate form");
    const packageDigest = form.identity.packageDigest;
    if (packageDigest === undefined) throw new Error("candidate package digest missing");
    const directory = new URL(
      "./fixtures/takoform-v1/forms/candidates/edge.forms.takoform.com/module-worker/",
      import.meta.url,
    );
    const manifest = (await Bun.file(
      new URL("package-index.json", directory),
    ).json()) as JsonObject;
    const declarations = manifest.files as readonly {
      readonly path: string;
      readonly digest: `sha256:${string}`;
      readonly mediaType?: string;
    }[];
    await createFormPackageStore(fixture.objects).put({
      packageDigest,
      formRef: form.identity.formRef,
      manifest,
      files: await Promise.all(
        declarations.map(async (declaration) => ({
          path: declaration.path,
          digest: declaration.digest,
          ...(declaration.mediaType ? { mediaType: declaration.mediaType } : {}),
          bytes: new Uint8Array(await Bun.file(new URL(declaration.path, directory)).arrayBuffer()),
        })),
      ),
    });

    expect((await fixture.authority.catalog(CONTEXT)).forms).toEqual([]);
    await expect(
      fixture.authority.authorizeMutation({
        operation: "create",
        context: CONTEXT,
        formRef: form.identity.formRef,
      }),
    ).rejects.toMatchObject({ code: "form_unavailable", status: 503 });
  });

  test("reads committed heads and observes deactivation without an isolate restart", async () => {
    const fixture = await committedAuthority();
    const first = await fixture.authority.authorizeMutation({
      operation: "create",
      context: CONTEXT,
      formRef: fixture.form.identity.formRef,
    });
    expect(first.packageDigest).toBe(fixture.packageDigest);
    expect(first.implementationDigest).toBe(fixture.implementationDigest);
    expect(first.form.operations).toEqual(["create", "read", "delete", "observe"]);
    expect((await fixture.authority.catalog(CONTEXT)).forms).toHaveLength(1);

    // A separately constructed reader sees the same durable heads after a
    // restart; the warm reader below must also see the successor immediately.
    const restarted = createTakoformHostAuthority({
      sql: fixture.sql,
      objects: fixture.objects,
      hostId: "host-a",
      candidates: fixture.catalog.forms,
      bindings: fixture.catalog.bindings,
      technicalAvailability: technicallyAvailable,
    });
    expect((await restarted.catalog(CONTEXT)).forms).toHaveLength(1);

    await fixture.writer.execute({
      kind: "SetActivation",
      formRef: fixture.form.identity.formRef,
      packageDigest: fixture.packageDigest,
      implementationDigest: fixture.implementationDigest,
      active: false,
      audience: fixture.audience,
      predecessorDigest: fixture.activation.eventDigest,
      actor: "test-operator",
      reason: "deactivate between reads",
    });
    await expect(
      fixture.authority.authorizeMutation({
        operation: "create",
        context: CONTEXT,
        formRef: fixture.form.identity.formRef,
      }),
    ).rejects.toMatchObject({ code: "form_unavailable", status: 503 });
    expect((await fixture.authority.catalog(CONTEXT)).forms[0]?.availability.activated).toBe(false);
  });

  test("keeps an admitted package discoverable but unsupported without an exact implementation candidate", async () => {
    const fixture = await committedAuthority();
    const withoutImplementation = createTakoformHostAuthority({
      sql: fixture.sql,
      objects: fixture.objects,
      hostId: "host-a",
      candidates: [],
      bindings: [],
      technicalAvailability: technicallyAvailable,
    });

    const catalog = await withoutImplementation.catalog(CONTEXT);
    expect(catalog.forms).toHaveLength(1);
    expect(catalog.forms[0]).toMatchObject({
      supported: false,
      availability: {
        executable: false,
        activated: false,
        availableToPrincipal: false,
      },
      form: {
        identity: {
          formRef: fixture.form.identity.formRef,
          packageDigest: fixture.packageDigest,
          implementationDigest: fixture.implementationDigest,
        },
        operations: [],
      },
    });
    expect(catalog.forms[0]?.form.desiredSchema).toEqual(fixture.form.desiredSchema);
    await expect(
      withoutImplementation.authorizeMutation({
        operation: "create",
        context: CONTEXT,
        formRef: fixture.form.identity.formRef,
      }),
    ).rejects.toMatchObject({ code: "form_unavailable", status: 503 });
  });

  test("treats support sealed to another public Worker Version as unsupported", async () => {
    const fixture = await committedAuthority();
    const current = createTakoformHostAuthority({
      sql: fixture.sql,
      objects: fixture.objects,
      hostId: "host-a",
      publicWorkerVersionId: PUBLIC_WORKER_VERSION_ID,
      candidates: fixture.catalog.forms,
      bindings: fixture.catalog.bindings,
      technicalAvailability: technicallyAvailable,
    });
    const stale = createTakoformHostAuthority({
      sql: fixture.sql,
      objects: fixture.objects,
      hostId: "host-a",
      publicWorkerVersionId: STALE_PUBLIC_WORKER_VERSION_ID,
      candidates: fixture.catalog.forms,
      bindings: fixture.catalog.bindings,
      technicalAvailability: technicallyAvailable,
    });

    expect((await current.catalog(CONTEXT)).forms[0]?.supported).toBe(true);
    expect((await stale.catalog(CONTEXT)).forms[0]).toMatchObject({
      supported: false,
      availability: {
        executable: false,
        activated: false,
        availableToPrincipal: false,
      },
    });
    await expect(
      stale.authorizeMutation({
        operation: "create",
        context: CONTEXT,
        formRef: fixture.form.identity.formRef,
      }),
    ).rejects.toMatchObject({ code: "form_unavailable", status: 503 });
  });

  test("fails current-profile authorization when immutable commit evidence is missing or malformed", async () => {
    const missing = await committedAuthority();
    await missing.sql.run(
      "UPDATE tf_form_publisher_events SET build_config_commit = NULL WHERE publisher_key = ?",
      ["publisher-a"],
    );
    await expect(missing.authority.catalog(CONTEXT)).rejects.toMatchObject({
      code: "form_unavailable",
      status: 503,
    });

    const decorated = await committedAuthority();
    await decorated.sql.run(
      "UPDATE tf_form_publisher_events SET source_commit = ? WHERE publisher_key = ?",
      ["git:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "publisher-a"],
    );
    await expect(
      decorated.authority.authorizeMutation({
        operation: "create",
        context: CONTEXT,
        formRef: decorated.form.identity.formRef,
      }),
    ).rejects.toMatchObject({ code: "form_unavailable", status: 503 });

    const coupledInstall = await committedAuthority();
    await expect(
      coupledInstall.sql.run(
        "UPDATE tf_form_install_events SET build_config_commit = NULL WHERE checkpoint_api_version = ?",
        [TAKOFORM_REVOCATION_V1],
      ),
    ).rejects.toMatchObject({ code: "constraint" });
  });

  test("rechecks the durable head after prepare and immediately before provider apply", async () => {
    const fixture = await committedAuthority();
    const counted = countingDriver();
    let deactivated = false;
    const host = createTakoformHost({
      sql: fixture.sql,
      objects: fixture.objects,
      forms: fixture.catalog.forms,
      bindings: fixture.catalog.bindings,
      authority: fixture.authority,
      driver: counted.driver,
      authenticate: async () => ({
        tenantId: CONTEXT.tenantId,
        principalId: CONTEXT.principalId,
        scope: {
          space: CONTEXT.space,
          formRef: fixture.form.identity.formRef,
          resourceName: "worker-a",
          mode: "provision" as const,
          claimCreate: async () => {
            if (deactivated) return;
            deactivated = true;
            await fixture.writer.execute({
              kind: "SetActivation",
              formRef: fixture.form.identity.formRef,
              packageDigest: fixture.packageDigest,
              implementationDigest: fixture.implementationDigest,
              active: false,
              audience: fixture.audience,
              predecessorDigest: fixture.activation.eventDigest,
              actor: "test-operator",
              reason: "deactivate at final create fence",
            });
          },
        },
      }),
    });
    const review = await prepareResource(host, fixture.form.identity.formRef);
    const response = await host.handle(
      new Request(`https://host.invalid${resourcePath(fixture.form.identity.formRef)}`, {
        method: "PUT",
        headers: {
          authorization: "Bearer test",
          "content-type": "application/json",
          "idempotency-key": "authority-race-1",
          "if-none-match": "*",
        },
        body: JSON.stringify(resourceBody(fixture.form.identity.formRef, review)),
      }),
    );
    expect(response?.status).toBe(503);
    expect(counted.calls.apply).toBe(0);
    expect(Number((await fixture.sql.query("SELECT COUNT(*) AS n FROM tf_resources"))[0]?.n)).toBe(
      0,
    );
    expect(
      Number(
        (await fixture.sql.query("SELECT COUNT(*) AS n FROM tf_provider_mutation_sagas"))[0]?.n,
      ),
    ).toBe(0);
  });

  test("a deferred resume reauthorizes fresh heads before any provider side effect", async () => {
    const fixture = await committedAuthority();
    const counted = countingDriver();
    const host = createTakoformHost({
      sql: fixture.sql,
      objects: fixture.objects,
      forms: fixture.catalog.forms,
      bindings: fixture.catalog.bindings,
      authority: fixture.authority,
      driver: counted.driver,
      deferredOperations: {
        shouldDefer: () => true,
        pollsBeforeCommit: 1,
        retryAfterSeconds: 0,
      },
      authenticate: async () => ({
        tenantId: CONTEXT.tenantId,
        principalId: CONTEXT.principalId,
      }),
    });
    const review = await prepareResource(host, fixture.form.identity.formRef);
    const accepted = await host.handle(
      new Request(`https://host.invalid${resourcePath(fixture.form.identity.formRef)}`, {
        method: "PUT",
        headers: {
          authorization: "Bearer test",
          "content-type": "application/json",
          "idempotency-key": "authority-deferred-1",
          "if-none-match": "*",
        },
        body: JSON.stringify(resourceBody(fixture.form.identity.formRef, review)),
      }),
    );
    expect(accepted?.status).toBe(202);
    if (!accepted) throw new Error("deferred create response missing");
    const acceptedBody = (await accepted.json()) as {
      readonly operation: { readonly id: string };
    };
    const operationId = String(acceptedBody.operation.id);
    await fixture.writer.execute({
      kind: "SetActivation",
      formRef: fixture.form.identity.formRef,
      packageDigest: fixture.packageDigest,
      implementationDigest: fixture.implementationDigest,
      active: false,
      audience: fixture.audience,
      predecessorDigest: fixture.activation.eventDigest,
      actor: "test-operator",
      reason: "deactivate before deferred resume",
    });
    let settled: Response | null = null;
    let settledBody: unknown = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      settled = await host.handle(
        new Request(`https://host.invalid/apis/forms.takoform.com/v1/operations/${operationId}`, {
          headers: { authorization: "Bearer test" },
        }),
      );
      settledBody = await settled?.json();
      if ((settledBody as { readonly done?: boolean } | null)?.done) break;
    }
    expect(settled?.status).toBe(200);
    expect(settledBody).toMatchObject({
      done: true,
      error: { code: "form_unavailable" },
    });
    expect(counted.calls.apply).toBe(0);
    expect(
      Number(
        (await fixture.sql.query("SELECT COUNT(*) AS n FROM tf_provider_mutation_sagas"))[0]?.n,
      ),
    ).toBe(0);
  });

  test("the final D1 fence rejects a head change that races the provider side effect", async () => {
    const fixture = await committedAuthority();
    const memory = new InMemoryTakoformResourceDriver();
    let applyCalls = 0;
    const driver: TakoformResourceDriver = {
      apply: async (input) => {
        applyCalls += 1;
        const receipt = await memory.apply(input);
        await fixture.writer.execute({
          kind: "SetActivation",
          formRef: fixture.form.identity.formRef,
          packageDigest: fixture.packageDigest,
          implementationDigest: fixture.implementationDigest,
          active: false,
          audience: fixture.audience,
          predecessorDigest: fixture.activation.eventDigest,
          actor: "test-operator",
          reason: "race after provider effect and before durable resource commit",
        });
        return receipt;
      },
      observe: (input) => memory.observe(input),
      delete: (input) => memory.delete(input),
      import: (input) => memory.import(input),
      sqliteMigrations: memory.sqliteMigrations,
    };
    const host = createTakoformHost({
      sql: fixture.sql,
      objects: fixture.objects,
      forms: fixture.catalog.forms,
      bindings: fixture.catalog.bindings,
      authority: fixture.authority,
      driver,
      authenticate: async () => ({
        tenantId: CONTEXT.tenantId,
        principalId: CONTEXT.principalId,
      }),
    });
    const review = await prepareResource(host, fixture.form.identity.formRef);
    const response = await host.handle(
      new Request(`https://host.invalid${resourcePath(fixture.form.identity.formRef)}`, {
        method: "PUT",
        headers: {
          authorization: "Bearer test",
          "content-type": "application/json",
          "idempotency-key": "authority-final-cas-race-1",
          "if-none-match": "*",
        },
        body: JSON.stringify(resourceBody(fixture.form.identity.formRef, review)),
      }),
    );

    expect(response?.status).toBe(409);
    expect(applyCalls).toBe(1);
    expect(Number((await fixture.sql.query("SELECT COUNT(*) AS n FROM tf_resources"))[0]?.n)).toBe(
      0,
    );
    expect(
      Number(
        (await fixture.sql.query("SELECT COUNT(*) AS n FROM tf_provider_mutation_sagas"))[0]?.n,
      ),
    ).toBe(1);
  });

  test("persists exact incarnation identity and retained delete survives current revocation", async () => {
    const fixture = await committedAuthority();
    const counted = countingDriver();
    const host = createTakoformHost({
      sql: fixture.sql,
      objects: fixture.objects,
      forms: fixture.catalog.forms,
      bindings: fixture.catalog.bindings,
      authority: fixture.authority,
      driver: counted.driver,
      authenticate: async () => ({
        tenantId: CONTEXT.tenantId,
        principalId: CONTEXT.principalId,
      }),
    });
    const review = await prepareResource(host, fixture.form.identity.formRef);
    const created = await host.handle(
      new Request(`https://host.invalid${resourcePath(fixture.form.identity.formRef)}`, {
        method: "PUT",
        headers: {
          authorization: "Bearer test",
          "content-type": "application/json",
          "idempotency-key": "authority-create-1",
          "if-none-match": "*",
        },
        body: JSON.stringify(resourceBody(fixture.form.identity.formRef, review)),
      }),
    );
    expect(created?.status).toBe(201);
    const identities = await fixture.sql.query(
      "SELECT package_digest, implementation_digest FROM tf_resources",
    );
    expect(identities).toEqual([
      {
        package_digest: fixture.packageDigest,
        implementation_digest: fixture.implementationDigest,
      },
    ]);

    const publisherRows = await fixture.sql.query(
      "SELECT event_digest FROM tf_form_publisher_events WHERE publisher_key = ?",
      ["publisher-a"],
    );
    const publisherRow = first(publisherRows, "publisher event");
    await fixture.writer.execute({
      kind: "AppendCheckpoint",
      publisherKey: "publisher-a",
      checkpointApiVersion: TAKOFORM_REVOCATION_V1,
      policyDigest: digest("1"),
      policyEventDigest: publisherRow.event_digest as AdmissionDigest,
      sequence: 1,
      checkpointDigest: digest("8"),
      entriesDigest: digest("7"),
      previousCheckpointDigest: TAKOFORM_REVOCATION_V1_GENESIS_DIGEST,
      predecessorDigest: fixture.checkpoint.eventDigest,
      revokedPackageDigests: [fixture.packageDigest],
      actor: "test-operator",
      reason: "revoke after resource creation",
    });
    await expect(
      fixture.authority.authorizeMutation({
        operation: "create",
        context: CONTEXT,
        formRef: fixture.form.identity.formRef,
      }),
    ).rejects.toMatchObject({ code: "form_unavailable" });

    const query = new URLSearchParams({
      space: CONTEXT.space,
      definitionVersion: fixture.form.identity.formRef.definitionVersion,
      schemaDigest: fixture.form.identity.formRef.schemaDigest,
    });
    const deleted = await host.handle(
      new Request(`https://host.invalid${resourcePath(fixture.form.identity.formRef)}?${query}`, {
        method: "DELETE",
        headers: {
          authorization: "Bearer test",
          "idempotency-key": "authority-delete-1",
          "takoform-expected-generation": "1",
        },
      }),
    );
    expect(deleted?.status).toBe(204);
    expect(counted.calls.delete).toBe(1);
  });

  test("R2 tamper and a tampered authority head list both fail closed", async () => {
    const fixture = await committedAuthority();
    const storedPackage = await createFormPackageStore(fixture.objects).read({
      packageDigest: fixture.packageDigest,
      formRef: fixture.form.identity.formRef,
    });
    if (!storedPackage) throw new Error("stored package missing");
    const definitionPath = String(
      (storedPackage.manifest as { readonly definitionPath: string }).definitionPath,
    );
    await fixture.objects.put(
      formPackageKey(fixture.packageDigest, definitionPath),
      new TextEncoder().encode("tampered"),
    );
    await expect(
      fixture.authority.authorizeMutation({
        operation: "create",
        context: CONTEXT,
        formRef: fixture.form.identity.formRef,
      }),
    ).rejects.toMatchObject({ code: "form_unavailable", status: 503 });

    const intact = await committedAuthority();
    const grant = await intact.authority.authorizeMutation({
      operation: "create",
      context: CONTEXT,
      formRef: intact.form.identity.formRef,
    });
    const store = createTakoformStore(intact.sql, () => new Date(1));
    await expect(
      store.commitImmediateMutation({
        tenantId: CONTEXT.tenantId,
        operationId: "op_tampered_fence",
        operation: "delete",
        createdAt: new Date(1).toISOString(),
        mutation: {
          kind: "delete",
          resourceUid: "uid_tampered_fence",
          address: {
            tenantId: CONTEXT.tenantId,
            space: CONTEXT.space,
            apiVersion: fixture.form.identity.formRef.apiVersion,
            kind: fixture.form.identity.formRef.kind,
            name: "missing",
          },
          expectedRevision: "missing",
          replayKey: "replay_tampered_fence",
          replay: { fingerprint: "tampered", status: 204 },
          authorityFence: {
            ...grant.fence,
            heads: grant.fence.heads.slice(1),
          },
        },
      }),
    ).rejects.toMatchObject({ code: "form_unavailable", status: 503 });
  });
});
