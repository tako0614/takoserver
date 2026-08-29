import { describe, expect, test } from "bun:test";
import { createEphemeralSql } from "../src/compat.ts";
import type { TakoformV1Alpha3FormRef } from "../src/form-ref.ts";
import { bytesDigest, canonicalDigest } from "../src/json.ts";
import { createMemoryObjectStore } from "../src/objects-mem.ts";
import { type ObjectStore, type Sql, SqlError } from "../src/ports.ts";
import {
  type AdmissionDigest,
  type AdmissionHandle,
  type AdmissionHandleClaims,
  type AdmissionPublisherPin,
  type AdmissionReport,
  createAdmissionHandleIssuer,
  TAKOFORM_REVOCATION_V1,
  TAKOFORM_REVOCATION_V1_EMPTY_ENTRIES_DIGEST,
  TAKOFORM_REVOCATION_V1_GENESIS_DIGEST,
  TAKOFORM_REVOCATION_V1ALPHA1,
} from "../src/takoform/admission.ts";
import { createFormAdmissionStore } from "../src/takoform/admission-store.ts";
import {
  createFormPackageStore,
  type FormPackageInput,
  type FormPackageStore,
  formPackageKey,
  formPackagePrefix,
  packageManifest,
} from "../src/takoform/form-packages.ts";
import { formGroupFromApiVersion } from "../src/takoform/forms.ts";

const digest = (hex: string): AdmissionDigest => `sha256:${hex.repeat(64)}` as AdmissionDigest;

const FORM_REF = {
  apiVersion: "example.forms.test/v1alpha1",
  kind: "Widget",
  definitionVersion: "1.0.0",
  schemaDigest: digest("a"),
} as const;

function publisher(overrides: Partial<AdmissionPublisherPin> = {}): AdmissionPublisherPin {
  return {
    publisherKey: "pub",
    policyDigest: digest("1"),
    policy: { apiVersion: "policy.forms.takoform.com/v1alpha1", mode: "reviewed" },
    oidcIssuer: "https://issuer.example.test",
    sourceRepository: "https://github.com/example/forms",
    workflow: ".github/workflows/release.yml",
    ref: "refs/tags/v1.0.0",
    identity: "external",
    trustedRootDigest: digest("2"),
    sourceCommit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    workflowCommit: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    buildConfigCommit: "cccccccccccccccccccccccccccccccccccccccc",
    repositoryIdentifier: "repo:example/forms",
    ownerIdentifier: "owner:example",
    group: "example.forms.test",
    namespaceGrantDigest: digest("3"),
    ...overrides,
  };
}

async function packageInput(
  formRef: TakoformV1Alpha3FormRef = FORM_REF,
  marker = "payload",
): Promise<FormPackageInput> {
  const bytes = new TextEncoder().encode(marker);
  const fileDigest = (await bytesDigest(bytes)) as AdmissionDigest;
  const file = {
    path: "definition.json",
    bytes,
    digest: fileDigest,
    mediaType: "application/json",
  };
  const manifest = packageManifest({
    formRef,
    files: [
      { path: file.path, digest: fileDigest, size: bytes.byteLength, mediaType: file.mediaType },
    ],
  });
  const packageDigest = (await canonicalDigest(manifest)) as AdmissionDigest;
  return { packageDigest, formRef, files: [file], manifest };
}

test("Form Package import is create-only and accepts only exact existing bytes", async () => {
  const objects = createMemoryObjectStore();
  const packages = createFormPackageStore(objects);
  const pkg = await packageInput();
  const first = await packages.put(pkg);
  const repeated = await packages.put(pkg);
  expect(repeated.packageDigest).toBe(first.packageDigest);
  expect(repeated.files.map((file) => file.bytes)).toEqual(first.files.map((file) => file.bytes));

  const conflictingObjects = createMemoryObjectStore();
  const conflictingPackages = createFormPackageStore(conflictingObjects);
  const file = pkg.files[0];
  if (!file) throw new Error("package fixture has no files");
  const key = formPackageKey(pkg.packageDigest, file.path);
  await conflictingObjects.put(key, new TextEncoder().encode("different existing bytes"));
  await expect(conflictingPackages.put(pkg)).rejects.toMatchObject({
    code: "package_readback_mismatch",
  });
  expect(await new Response((await conflictingObjects.get(key))?.body).text()).toBe(
    "different existing bytes",
  );
  expect(
    await conflictingObjects.get(`${formPackagePrefix(pkg.packageDigest)}/package-index.json`),
  ).toBeNull();
});

function admissionReport(
  pkg: FormPackageInput,
  pub: AdmissionPublisherPin,
  allow: { readonly eventDigest: AdmissionDigest },
  _checkpointReceipt: { readonly eventDigest: AdmissionDigest },
  operation: "install" | "replace" = "install",
): AdmissionReport {
  const payloadBytes = pkg.files.reduce((total, file) => {
    if (file.bytes instanceof Uint8Array) return total + file.bytes.byteLength;
    return total;
  }, 0);
  return {
    status: "admitted",
    operation,
    package: {
      packageDigest: pkg.packageDigest,
      formRef: pkg.formRef,
      fileCount: pkg.files.length,
      payloadBytes,
    },
    publisher: {
      policyDigest: pub.policyDigest,
      oidcIssuer: pub.oidcIssuer,
      sourceRepository: pub.sourceRepository,
      workflow: pub.workflow,
      ref: pub.ref,
      identity: pub.identity,
    },
    source: {
      sourceCommit: pub.sourceCommit,
      workflowCommit: pub.workflowCommit,
      buildConfigCommit: pub.buildConfigCommit,
      repositoryIdentifier: pub.repositoryIdentifier,
      ownerIdentifier: pub.ownerIdentifier,
    },
    namespace: {
      group: pub.group,
      namespaceGrantDigest: pub.namespaceGrantDigest,
    },
    signature: {
      subjectDigest: pkg.packageDigest,
      bundleDigest: allow.eventDigest,
      trustedRootDigest: pub.trustedRootDigest,
    },
    revocation: {
      checkpointApiVersion: TAKOFORM_REVOCATION_V1ALPHA1,
      sequence: 1,
      checkpointDigest: digest("4"),
      entriesDigest: digest("5"),
      revoked: false,
    },
    checks: [{ code: "focused", passed: true }],
  };
}

async function fixture(
  options: {
    readonly sql?: Sql;
    readonly objects?: ObjectStore;
    readonly packages?: FormPackageStore;
    readonly formRef?: TakoformV1Alpha3FormRef;
    readonly publisherOverrides?: Partial<AdmissionPublisherPin>;
  } = {},
) {
  const formRef = options.formRef ?? FORM_REF;
  const sql = options.sql ?? createEphemeralSql();
  const objects = options.objects ?? createMemoryObjectStore();
  const packages = options.packages ?? createFormPackageStore(objects);
  const handles = createAdmissionHandleIssuer();
  const host = createFormAdmissionStore({ sql, objects, packages, handles });
  const pub = publisher(options.publisherOverrides);
  const allow = await host.execute({
    kind: "AllowPublisher",
    publisher: pub,
    actor: "test-operator",
    reason: "focused test",
  });
  const checkpoint = digest("4");
  const entries = digest("5");
  const checkpointReceipt = await host.execute({
    kind: "AppendCheckpoint",
    publisherKey: "pub",
    checkpointApiVersion: TAKOFORM_REVOCATION_V1ALPHA1,
    policyDigest: pub.policyDigest,
    policyEventDigest: allow.eventDigest,
    sequence: 1,
    checkpointDigest: checkpoint,
    entriesDigest: entries,
    previousCheckpointDigest: null,
    actor: "test-operator",
    reason: "focused test",
  });
  const pkg = await packageInput(formRef);
  const report = admissionReport(pkg, pub, allow, checkpointReceipt);
  const handleClaims: AdmissionHandleClaims = {
    operation: "install",
    packageDigest: pkg.packageDigest,
    formRef,
    publisherKey: "pub",
    publisher: pub,
    policyEventDigest: allow.eventDigest,
    checkpointApiVersion: TAKOFORM_REVOCATION_V1ALPHA1,
    checkpointSequence: 1,
    checkpointDigest: checkpoint,
    checkpointEventDigest: checkpointReceipt.eventDigest,
    report,
  };
  const handle = handles.issue(handleClaims);
  return {
    sql,
    objects,
    packages,
    host,
    handles,
    pub,
    allow,
    checkpointReceipt,
    pkg,
    handle,
    handleClaims,
  };
}

async function count(sql: Sql, table: string): Promise<number> {
  const rows = await sql.query(`SELECT COUNT(*) AS n FROM ${table}`);
  return Number(rows[0]?.n ?? 0);
}

async function insertResource(
  sql: Sql,
  packageDigest: AdmissionDigest,
  implementationDigest: AdmissionDigest,
  uid = "resource_uid_a",
): Promise<void> {
  await sql.run(
    `INSERT INTO tf_resources
       (tenant_id, space, api_version, kind, name, uid, generation, revision,
        resource_json, package_digest, implementation_digest, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      "tenant-a",
      "default",
      FORM_REF.apiVersion,
      FORM_REF.kind,
      "resource-a",
      uid,
      "1",
      "rev-a",
      JSON.stringify({
        form: {
          formRef: FORM_REF,
          packageDigest,
          implementationDigest,
        },
      }),
      packageDigest,
      implementationDigest,
      1,
    ],
  );
}

describe("private Takoform Host admission substrate", () => {
  test("extracts exact stable and retained Form family groups", () => {
    expect(formGroupFromApiVersion("edge.forms.takoform.com")).toBe("edge.forms.takoform.com");
    expect(formGroupFromApiVersion("edge.forms.takoform.com/v1beta1")).toBe(
      "edge.forms.takoform.com",
    );
    expect(formGroupFromApiVersion("edge.forms.takoform.com/v1beta1/extra")).toBeNull();
    expect(formGroupFromApiVersion("edge.forms.takoform.com/not-a-version")).toBeNull();
  });

  test("admits an exact versionless family and retains the legacy versioned family", async () => {
    const stableFormRef = { ...FORM_REF, apiVersion: "edge.forms.takoform.com" };
    const stable = await fixture({
      formRef: stableFormRef,
      publisherOverrides: { group: stableFormRef.apiVersion },
    });
    const stableInstall = await stable.host.execute({
      kind: "InstallPackage",
      package: stable.pkg,
      handle: stable.handle,
      actor: "test-operator",
      reason: "install stable versionless package",
    });
    expect(stableInstall.state).toBe("install");

    const legacy = await fixture();
    const legacyInstall = await legacy.host.execute({
      kind: "InstallPackage",
      package: legacy.pkg,
      handle: legacy.handle,
      actor: "test-operator",
      reason: "install retained versioned package",
    });
    expect(legacyInstall.state).toBe("install");
  });

  test("denies namespace prefixes and malformed apiVersions instead of truncating them", async () => {
    const stableFormRef = { ...FORM_REF, apiVersion: "edge.forms.takoform.com" };
    const f = await fixture({
      formRef: stableFormRef,
      publisherOverrides: { group: stableFormRef.apiVersion },
    });
    const truncatedPublisher = publisher({ ...f.pub, group: "edge.forms.takoform.co" });
    const truncatedReport = admissionReport(
      f.pkg,
      truncatedPublisher,
      f.allow,
      f.checkpointReceipt,
    );
    expect(() =>
      f.handles.issue({
        ...f.handleClaims,
        publisher: truncatedPublisher,
        report: truncatedReport,
      }),
    ).toThrow("publisher namespace does not match Form group");

    const malformedFormRef = {
      ...stableFormRef,
      apiVersion: "edge.forms.takoform.com/v1beta1/extra",
    };
    expect(() =>
      f.handles.issue({
        ...f.handleClaims,
        formRef: malformedFormRef,
      }),
    ).toThrow("invalid FormRef in handle claims");
  });

  test("serialized verification evidence cannot forge the Host private handle", async () => {
    const f = await fixture();
    const forged = JSON.parse(
      JSON.stringify({
        report: f.handleClaims.report,
        publisher: f.handleClaims.publisher,
        policyEventDigest: f.handleClaims.policyEventDigest,
        checkpointEventDigest: f.handleClaims.checkpointEventDigest,
      }),
    ) as AdmissionHandle;

    await expect(
      f.host.execute({
        kind: "InstallPackage",
        package: f.pkg,
        handle: forged,
        actor: "test-operator",
        reason: "forged report",
      }),
    ).rejects.toMatchObject({
      code: "invalid_handle",
      message: "package install needs a Host-issued private handle",
    });
    expect(await count(f.sql, "tf_form_install_events")).toBe(0);
  });

  test("a handle must carry an admitted report and the persisted digest is computed from its body", async () => {
    const f = await fixture();
    try {
      f.handles.issue({
        ...f.handleClaims,
        report: undefined as never,
      });
      throw new Error("missing report was accepted");
    } catch (error) {
      expect(error).toMatchObject({ code: "invalid_handle" });
    }

    await f.host.execute({
      kind: "InstallPackage",
      package: f.pkg,
      handle: f.handle,
      actor: "test-operator",
      reason: "persist report",
    });
    const rows = await f.sql.query(
      "SELECT admission_report_digest, admission_report_json FROM tf_form_install_events LIMIT 1",
    );
    expect(rows[0]?.admission_report_digest).toBe(
      await (await import("../src/takoform/admission.ts")).digestAdmissionReport(
        f.handleClaims.report,
      ),
    );
    expect(JSON.parse(String(rows[0]?.admission_report_json))).toEqual(f.handleClaims.report);
  });

  test("a report whose package totals do not match read-back bytes cannot install", async () => {
    const f = await fixture();
    const mismatchedReport = {
      ...f.handleClaims.report,
      package: {
        ...f.handleClaims.report.package,
        payloadBytes: f.handleClaims.report.package.payloadBytes + 1,
      },
    };
    const handle = f.handles.issue({ ...f.handleClaims, report: mismatchedReport });
    await expect(
      f.host.execute({
        kind: "InstallPackage",
        package: f.pkg,
        handle,
        actor: "test-operator",
        reason: "mismatched report",
      }),
    ).rejects.toMatchObject({ code: "handle_mismatch" });
    expect(await count(f.sql, "tf_form_install_events")).toBe(0);
  });

  test("a policy head change between Host decision and commit rejects the stale handle", async () => {
    const f = await fixture();
    await f.host.execute({
      kind: "RotatePublisher",
      publisher: publisher({ policyDigest: digest("7"), identity: "external-rotated" }),
      actor: "test-operator",
      reason: "rotate policy",
      predecessorDigest: f.allow.eventDigest,
    });

    await expect(
      f.host.execute({
        kind: "InstallPackage",
        package: f.pkg,
        handle: f.handle,
        actor: "test-operator",
        reason: "stale policy",
      }),
    ).rejects.toMatchObject({ code: "admission_conflict" });
    expect(await count(f.sql, "tf_form_install_events")).toBe(0);
  });

  test("install CAS compares every durable publisher pin and checkpoint entries digest", async () => {
    const f = await fixture();
    const alteredPins: ReadonlyArray<
      readonly [string, (publisher: AdmissionPublisherPin) => AdmissionPublisherPin]
    > = [
      [
        "oidc issuer",
        (value) => publisher({ ...value, oidcIssuer: "https://altered.example.test" }),
      ],
      [
        "source repository",
        (value) => publisher({ ...value, sourceRepository: "https://github.com/other/forms" }),
      ],
      ["workflow", (value) => publisher({ ...value, workflow: ".github/workflows/other.yml" })],
      ["ref", (value) => publisher({ ...value, ref: "refs/tags/v9.9.9" })],
      ["identity", (value) => publisher({ ...value, identity: "altered" })],
      [
        "source commit",
        (value) =>
          publisher({ ...value, sourceCommit: "dddddddddddddddddddddddddddddddddddddddd" }),
      ],
      [
        "workflow commit",
        (value) =>
          publisher({ ...value, workflowCommit: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" }),
      ],
      [
        "build config commit",
        (value) =>
          publisher({ ...value, buildConfigCommit: "ffffffffffffffffffffffffffffffffffffffff" }),
      ],
      [
        "repository identifier",
        (value) => publisher({ ...value, repositoryIdentifier: "repo:other/forms" }),
      ],
      ["owner identifier", (value) => publisher({ ...value, ownerIdentifier: "owner:other" })],
      ["namespace grant", (value) => publisher({ ...value, namespaceGrantDigest: digest("6") })],
      ["trusted root", (value) => publisher({ ...value, trustedRootDigest: digest("7") })],
    ];

    for (const [label, alter] of alteredPins) {
      const alteredPublisher = alter(f.pub);
      const report = admissionReport(f.pkg, alteredPublisher, f.allow, f.checkpointReceipt);
      const handle = f.handles.issue({
        ...f.handleClaims,
        publisher: alteredPublisher,
        report,
      });
      await expect(
        f.host.execute({
          kind: "InstallPackage",
          package: f.pkg,
          handle,
          actor: "test-operator",
          reason: `altered ${label}`,
        }),
      ).rejects.toMatchObject({ code: "admission_conflict" });
    }

    const alteredEntriesReport: AdmissionReport = {
      ...f.handleClaims.report,
      revocation: {
        ...f.handleClaims.report.revocation,
        entriesDigest: digest("6"),
      },
    };
    const alteredEntriesHandle = f.handles.issue({
      ...f.handleClaims,
      report: alteredEntriesReport,
    });
    await expect(
      f.host.execute({
        kind: "InstallPackage",
        package: f.pkg,
        handle: alteredEntriesHandle,
        actor: "test-operator",
        reason: "altered checkpoint entries digest",
      }),
    ).rejects.toMatchObject({ code: "admission_conflict" });

    const alteredGroup = publisher({ group: "other.forms.test" });
    const alteredGroupReport = admissionReport(f.pkg, alteredGroup, f.allow, f.checkpointReceipt);
    expect(() =>
      f.handles.issue({
        ...f.handleClaims,
        publisher: alteredGroup,
        report: alteredGroupReport,
      }),
    ).toThrow();
    expect(await count(f.sql, "tf_form_install_events")).toBe(0);
  });

  test("the predecessor fence lets only one concurrent install win", async () => {
    const f = await fixture();
    const commands = [0, 1].map(() =>
      f.host.execute({
        kind: "InstallPackage" as const,
        package: f.pkg,
        handle: f.handle,
        actor: "test-operator",
        reason: "concurrent install",
      }),
    );
    const results = await Promise.allSettled(commands);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(await count(f.sql, "tf_form_install_events")).toBe(1);
  });

  test("checkpoint sequence and predecessor fences reject concurrent successors", async () => {
    const f = await fixture();
    const commands = [0, 1].map(() =>
      f.host.execute({
        kind: "AppendCheckpoint" as const,
        publisherKey: "pub",
        checkpointApiVersion: TAKOFORM_REVOCATION_V1ALPHA1,
        policyDigest: f.pub.policyDigest,
        policyEventDigest: f.allow.eventDigest,
        sequence: 2,
        checkpointDigest: digest("9"),
        entriesDigest: digest("b"),
        previousCheckpointDigest: digest("4"),
        predecessorDigest: f.checkpointReceipt.eventDigest,
        actor: "test-operator",
        reason: "concurrent checkpoint",
      }),
    );
    const results = await Promise.allSettled(commands);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(await count(f.sql, "tf_form_revocation_checkpoints")).toBe(2);
  });

  test("accepts sequence zero only as the exact stable signed genesis lane", async () => {
    const f = await fixture();
    await expect(
      f.host.execute({
        kind: "AppendCheckpoint",
        publisherKey: "pub",
        checkpointApiVersion: TAKOFORM_REVOCATION_V1,
        policyDigest: f.pub.policyDigest,
        policyEventDigest: f.allow.eventDigest,
        sequence: 0,
        checkpointDigest: digest("9"),
        entriesDigest: TAKOFORM_REVOCATION_V1_EMPTY_ENTRIES_DIGEST,
        previousCheckpointDigest: null,
        actor: "test-operator",
        reason: "wrong stable genesis",
      }),
    ).rejects.toMatchObject({ code: "checkpoint_invalid" });

    const stable = await f.host.execute({
      kind: "AppendCheckpoint",
      publisherKey: "pub",
      checkpointApiVersion: TAKOFORM_REVOCATION_V1,
      policyDigest: f.pub.policyDigest,
      policyEventDigest: f.allow.eventDigest,
      sequence: 0,
      checkpointDigest: TAKOFORM_REVOCATION_V1_GENESIS_DIGEST,
      entriesDigest: TAKOFORM_REVOCATION_V1_EMPTY_ENTRIES_DIGEST,
      previousCheckpointDigest: null,
      revokedPackageDigests: [],
      actor: "test-operator",
      reason: "exact stable genesis",
    });
    expect(stable.changed).toBe(true);

    await expect(
      f.host.execute({
        kind: "AppendCheckpoint",
        publisherKey: "pub",
        checkpointApiVersion: TAKOFORM_REVOCATION_V1ALPHA1,
        policyDigest: f.pub.policyDigest,
        policyEventDigest: f.allow.eventDigest,
        sequence: 0,
        checkpointDigest: TAKOFORM_REVOCATION_V1_GENESIS_DIGEST,
        entriesDigest: TAKOFORM_REVOCATION_V1_EMPTY_ENTRIES_DIGEST,
        previousCheckpointDigest: null,
        actor: "test-operator",
        reason: "cross-profile sequence zero",
      }),
    ).rejects.toMatchObject({ code: "checkpoint_invalid" });
  });

  test("rejects missing, decorated, or non-lowercase publisher commit identities", async () => {
    const sql = createEphemeralSql();
    const handles = createAdmissionHandleIssuer();
    const host = createFormAdmissionStore({ sql, objects: createMemoryObjectStore(), handles });
    const invalidPublishers = [
      publisher({ sourceCommit: "git:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }),
      publisher({ workflowCommit: "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB" }),
      { ...publisher(), buildConfigCommit: undefined } as unknown as AdmissionPublisherPin,
    ];
    for (const [index, invalid] of invalidPublishers.entries()) {
      await expect(
        host.execute({
          kind: "AllowPublisher",
          publisher: { ...invalid, publisherKey: `invalid-${index}` },
          actor: "test-operator",
          reason: "invalid immutable commit",
        }),
      ).rejects.toMatchObject({ code: "invalid_command" });
    }
    expect(await count(sql, "tf_form_publisher_events")).toBe(0);
  });

  test("object bytes may remain unreferenced when the guarded SQL insert fails", async () => {
    const base = createEphemeralSql();
    const failingSql: Sql = {
      query: (sql, params) => base.query(sql, params),
      batch: (statements) => base.batch(statements),
      run: async (sql, params) => {
        if (sql.includes("INSERT INTO tf_form_install_events")) {
          throw new SqlError("unavailable", "simulated install SQL outage");
        }
        return base.run(sql, params);
      },
    };
    const f = await fixture({ sql: failingSql });

    await expect(
      f.host.execute({
        kind: "InstallPackage",
        package: f.pkg,
        handle: f.handle,
        actor: "test-operator",
        reason: "SQL outage",
      }),
    ).rejects.toBeInstanceOf(SqlError);
    expect(await count(base, "tf_form_install_events")).toBe(0);
    const objects = await f.objects.list({
      prefix: `${formPackagePrefix(f.pkg.packageDigest)}/`,
      limit: 100,
    });
    expect(objects.objects.length).toBeGreaterThan(0);
  });

  test("an install that loses to a concurrent purge repairs its just-written bytes", async () => {
    const objects = createMemoryObjectStore();
    const durablePackages = createFormPackageStore(objects);
    let host: ReturnType<typeof createFormAdmissionStore> | null = null;
    let armPurge = false;
    let purgeTriggered = false;
    const packages: FormPackageStore = {
      put: async (input) => {
        const stored = await durablePackages.put(input);
        if (armPurge && !purgeTriggered) {
          purgeTriggered = true;
          if (!host) throw new Error("host is not ready");
          await host.execute({
            kind: "PurgePackage",
            formRef: input.formRef,
            packageDigest: input.packageDigest,
            actor: "test-operator",
            reason: "interleaved purge",
          });
        }
        return stored;
      },
      read: (input) => durablePackages.read(input),
      purge: (packageDigest) => durablePackages.purge(packageDigest),
    };
    const f = await fixture({ objects, packages });
    host = f.host;
    await f.host.execute({
      kind: "InstallPackage",
      package: f.pkg,
      handle: f.handle,
      actor: "test-operator",
      reason: "install package",
    });
    const replacement = await packageInput(FORM_REF, "replacement");
    const replacementHandle = f.handles.issue({
      ...f.handleClaims,
      operation: "replace",
      packageDigest: replacement.packageDigest,
      report: admissionReport(replacement, f.pub, f.allow, f.checkpointReceipt, "replace"),
    });
    await f.host.execute({
      kind: "ReplacePackage",
      package: replacement,
      handle: replacementHandle,
      actor: "test-operator",
      reason: "replace package",
    });

    const replaceBackHandle = f.handles.issue({
      ...f.handleClaims,
      operation: "replace",
      report: admissionReport(f.pkg, f.pub, f.allow, f.checkpointReceipt, "replace"),
    });
    armPurge = true;
    await expect(
      f.host.execute({
        kind: "ReplacePackage",
        package: f.pkg,
        handle: replaceBackHandle,
        actor: "test-operator",
        reason: "replace loses to purge",
      }),
    ).rejects.toMatchObject({ code: "admission_conflict" });

    expect(purgeTriggered).toBe(true);
    expect(await count(f.sql, "tf_form_package_purge_events")).toBe(2);
    expect(await count(f.sql, "tf_form_install_events")).toBe(2);
    expect(
      (await f.objects.list({ prefix: `${formPackagePrefix(f.pkg.packageDigest)}/`, limit: 100 }))
        .objects,
    ).toHaveLength(0);
    const installHead = await f.host.inspect({
      kind: "Package",
      formRef: FORM_REF,
      packageDigest: replacement.packageDigest,
    });
    expect(installHead.install).toMatchObject({ package_digest: replacement.packageDigest });
  });

  test("failed install-byte cleanup reports unavailable and terminal purge retry repairs it", async () => {
    const objects = createMemoryObjectStore();
    const durablePackages = createFormPackageStore(objects);
    let host: ReturnType<typeof createFormAdmissionStore> | null = null;
    let armPurge = false;
    let purgeTriggered = false;
    let purgeCalls = 0;
    const packages: FormPackageStore = {
      put: async (input) => {
        const stored = await durablePackages.put(input);
        if (armPurge && !purgeTriggered) {
          purgeTriggered = true;
          if (!host) throw new Error("host is not ready");
          await host.execute({
            kind: "PurgePackage",
            formRef: input.formRef,
            packageDigest: input.packageDigest,
            actor: "test-operator",
            reason: "interleaved purge",
          });
        }
        return stored;
      },
      read: (input) => durablePackages.read(input),
      purge: async (packageDigest) => {
        purgeCalls += 1;
        if (purgeCalls === 1) return;
        if (purgeCalls === 2) throw new Error("simulated install cleanup outage");
        await durablePackages.purge(packageDigest);
      },
    };
    const f = await fixture({ objects, packages });
    host = f.host;
    await f.host.execute({
      kind: "InstallPackage",
      package: f.pkg,
      handle: f.handle,
      actor: "test-operator",
      reason: "install package",
    });
    const replacement = await packageInput(FORM_REF, "replacement");
    const replacementHandle = f.handles.issue({
      ...f.handleClaims,
      operation: "replace",
      packageDigest: replacement.packageDigest,
      report: admissionReport(replacement, f.pub, f.allow, f.checkpointReceipt, "replace"),
    });
    await f.host.execute({
      kind: "ReplacePackage",
      package: replacement,
      handle: replacementHandle,
      actor: "test-operator",
      reason: "replace package",
    });

    const replaceBackHandle = f.handles.issue({
      ...f.handleClaims,
      operation: "replace",
      report: admissionReport(f.pkg, f.pub, f.allow, f.checkpointReceipt, "replace"),
    });
    armPurge = true;
    await expect(
      f.host.execute({
        kind: "ReplacePackage",
        package: f.pkg,
        handle: replaceBackHandle,
        actor: "test-operator",
        reason: "replace cleanup outage",
      }),
    ).rejects.toMatchObject({ code: "package_store_unavailable" });
    expect(purgeTriggered).toBe(true);
    expect(await count(f.sql, "tf_form_package_purge_events")).toBe(2);
    expect(
      (await f.objects.list({ prefix: `${formPackagePrefix(f.pkg.packageDigest)}/`, limit: 100 }))
        .objects.length,
    ).toBeGreaterThan(0);

    const repaired = await f.host.execute({
      kind: "PurgePackage",
      formRef: FORM_REF,
      packageDigest: f.pkg.packageDigest,
      actor: "test-operator",
      reason: "repair failed install cleanup",
    });
    expect(repaired).toMatchObject({ state: "purged", changed: false });
    expect(purgeCalls).toBe(3);
    expect(
      (await f.objects.list({ prefix: `${formPackagePrefix(f.pkg.packageDigest)}/`, limit: 100 }))
        .objects,
    ).toHaveLength(0);
  });

  test("install alone creates no support, activation, or Resource state", async () => {
    const f = await fixture();
    await f.host.execute({
      kind: "InstallPackage",
      package: f.pkg,
      handle: f.handle,
      actor: "test-operator",
      reason: "install package",
    });

    expect(await count(f.sql, "tf_form_install_events")).toBe(1);
    expect(await count(f.sql, "tf_form_support_events")).toBe(0);
    expect(await count(f.sql, "tf_form_activation_events")).toBe(0);
    expect(await count(f.sql, "tf_resources")).toBe(0);
  });

  test("purge refuses the current installed package until it is uninstalled", async () => {
    const f = await fixture();
    await f.host.execute({
      kind: "InstallPackage",
      package: f.pkg,
      handle: f.handle,
      actor: "test-operator",
      reason: "install package",
    });

    await expect(
      f.host.execute({
        kind: "PurgePackage",
        formRef: FORM_REF,
        packageDigest: f.pkg.packageDigest,
        actor: "test-operator",
        reason: "purge active package",
      }),
    ).rejects.toMatchObject({ code: "admission_conflict" });
    expect(await count(f.sql, "tf_form_install_events")).toBe(1);
    expect(await count(f.sql, "tf_form_package_purge_events")).toBe(0);
    expect(
      (await f.objects.list({ prefix: `${formPackagePrefix(f.pkg.packageDigest)}/`, limit: 100 }))
        .objects.length,
    ).toBeGreaterThan(0);
  });

  test("uninstall preserves package bytes and records an append-only install successor", async () => {
    const f = await fixture();
    await f.host.execute({
      kind: "InstallPackage",
      package: f.pkg,
      handle: f.handle,
      actor: "test-operator",
      reason: "install package",
    });
    const uninstalled = await f.host.execute({
      kind: "UninstallPackage",
      formRef: FORM_REF,
      packageDigest: f.pkg.packageDigest,
      actor: "test-operator",
      reason: "uninstall package",
    });
    expect(uninstalled.state).toBe("uninstall");
    expect(await count(f.sql, "tf_form_install_events")).toBe(2);
    expect(
      (await f.objects.list({ prefix: `${formPackagePrefix(f.pkg.packageDigest)}/`, limit: 100 }))
        .objects.length,
    ).toBeGreaterThan(0);
    const packageView = await f.host.inspect({
      kind: "Package",
      formRef: FORM_REF,
      packageDigest: f.pkg.packageDigest,
    });
    expect(packageView.install).toMatchObject({ event_type: "uninstall" });
  });

  test("replace advances the install chain while retaining the previous package bytes", async () => {
    const f = await fixture();
    await f.host.execute({
      kind: "InstallPackage",
      package: f.pkg,
      handle: f.handle,
      actor: "test-operator",
      reason: "install package",
    });
    const replacement = await packageInput(FORM_REF, "replacement");
    const replacementHandle = f.handles.issue({
      operation: "replace",
      packageDigest: replacement.packageDigest,
      formRef: FORM_REF,
      publisherKey: "pub",
      publisher: f.pub,
      policyEventDigest: f.allow.eventDigest,
      checkpointApiVersion: TAKOFORM_REVOCATION_V1ALPHA1,
      checkpointSequence: 1,
      checkpointDigest: digest("4"),
      checkpointEventDigest: f.checkpointReceipt.eventDigest,
      report: admissionReport(replacement, f.pub, f.allow, f.checkpointReceipt, "replace"),
    });
    const replaced = await f.host.execute({
      kind: "ReplacePackage",
      package: replacement,
      handle: replacementHandle,
      actor: "test-operator",
      reason: "replace package",
    });
    expect(replaced.state).toBe("replace");
    expect(await count(f.sql, "tf_form_install_events")).toBe(2);
    expect(
      (await f.objects.list({ prefix: `${formPackagePrefix(f.pkg.packageDigest)}/`, limit: 100 }))
        .objects.length,
    ).toBeGreaterThan(0);
    expect(
      (
        await f.objects.list({
          prefix: `${formPackagePrefix(replacement.packageDigest)}/`,
          limit: 100,
        })
      ).objects.length,
    ).toBeGreaterThan(0);
  });

  test("a purged digest cannot be reinstalled after uninstall", async () => {
    const f = await fixture();
    await f.host.execute({
      kind: "InstallPackage",
      package: f.pkg,
      handle: f.handle,
      actor: "test-operator",
      reason: "install package",
    });
    await f.host.execute({
      kind: "UninstallPackage",
      formRef: FORM_REF,
      packageDigest: f.pkg.packageDigest,
      actor: "test-operator",
      reason: "uninstall package",
    });
    await f.host.execute({
      kind: "PurgePackage",
      formRef: FORM_REF,
      packageDigest: f.pkg.packageDigest,
      actor: "test-operator",
      reason: "purge package",
    });

    await expect(
      f.host.execute({
        kind: "InstallPackage",
        package: f.pkg,
        handle: f.handle,
        actor: "test-operator",
        reason: "reinstall purged package",
      }),
    ).rejects.toMatchObject({ code: "admission_conflict" });
    const repeated = await f.host.execute({
      kind: "PurgePackage",
      formRef: FORM_REF,
      packageDigest: f.pkg.packageDigest,
      actor: "test-operator",
      reason: "repeat purge",
    });
    expect(repeated).toMatchObject({ state: "purged", changed: false });
    expect(await count(f.sql, "tf_form_install_events")).toBe(2);
    expect(await count(f.sql, "tf_form_package_purge_events")).toBe(2);
  });

  test("a purged superseded digest cannot be used for replace-back", async () => {
    const f = await fixture();
    await f.host.execute({
      kind: "InstallPackage",
      package: f.pkg,
      handle: f.handle,
      actor: "test-operator",
      reason: "install package",
    });
    const replacement = await packageInput(FORM_REF, "replacement");
    const replacementHandle = f.handles.issue({
      ...f.handleClaims,
      operation: "replace",
      packageDigest: replacement.packageDigest,
      report: admissionReport(replacement, f.pub, f.allow, f.checkpointReceipt, "replace"),
    });
    await f.host.execute({
      kind: "ReplacePackage",
      package: replacement,
      handle: replacementHandle,
      actor: "test-operator",
      reason: "replace package",
    });
    await f.host.execute({
      kind: "PurgePackage",
      formRef: FORM_REF,
      packageDigest: f.pkg.packageDigest,
      actor: "test-operator",
      reason: "purge superseded package",
    });

    const replaceBackHandle = f.handles.issue({
      ...f.handleClaims,
      operation: "replace",
      report: admissionReport(f.pkg, f.pub, f.allow, f.checkpointReceipt, "replace"),
    });
    await expect(
      f.host.execute({
        kind: "ReplacePackage",
        package: f.pkg,
        handle: replaceBackHandle,
        actor: "test-operator",
        reason: "replace back purged package",
      }),
    ).rejects.toMatchObject({ code: "admission_conflict" });
    const installHead = await f.host.inspect({
      kind: "Package",
      formRef: FORM_REF,
      packageDigest: replacement.packageDigest,
    });
    expect(installHead.install).toMatchObject({ package_digest: replacement.packageDigest });
    expect(await count(f.sql, "tf_form_package_purge_events")).toBe(2);
  });

  test("superseded package cleanup deactivates, unsupports, and purges without moving install head", async () => {
    const f = await fixture();
    await f.host.execute({
      kind: "InstallPackage",
      package: f.pkg,
      handle: f.handle,
      actor: "test-operator",
      reason: "install package",
    });
    const implementationDigest = digest("8");
    await f.host.execute({
      kind: "SetSupport",
      formRef: FORM_REF,
      packageDigest: f.pkg.packageDigest,
      supported: true,
      profile: { apiVersion: "support.takoform.com/v1alpha1" },
      operations: ["read"],
      implementationDigest,
      actor: "test-operator",
      reason: "support old package",
    });
    await f.host.execute({
      kind: "SetActivation",
      formRef: FORM_REF,
      packageDigest: f.pkg.packageDigest,
      active: true,
      audience: { kind: "host", value: "host" },
      implementationDigest,
      actor: "test-operator",
      reason: "activate old package",
    });
    const replacement = await packageInput(FORM_REF, "superseding");
    const replacementHandle = f.handles.issue({
      ...f.handleClaims,
      operation: "replace",
      packageDigest: replacement.packageDigest,
      report: admissionReport(replacement, f.pub, f.allow, f.checkpointReceipt, "replace"),
    });
    await f.host.execute({
      kind: "ReplacePackage",
      package: replacement,
      handle: replacementHandle,
      actor: "test-operator",
      reason: "replace package",
    });

    await f.host.execute({
      kind: "SetActivation",
      formRef: FORM_REF,
      packageDigest: f.pkg.packageDigest,
      active: false,
      audience: { kind: "host", value: "host" },
      implementationDigest,
      actor: "test-operator",
      reason: "deactivate superseded package",
    });
    await f.host.execute({
      kind: "SetSupport",
      formRef: FORM_REF,
      packageDigest: f.pkg.packageDigest,
      supported: false,
      profile: { apiVersion: "support.takoform.com/v1alpha1" },
      operations: ["read"],
      implementationDigest,
      actor: "test-operator",
      reason: "unsupport superseded package",
    });
    await f.host.execute({
      kind: "PurgePackage",
      formRef: FORM_REF,
      packageDigest: f.pkg.packageDigest,
      actor: "test-operator",
      reason: "purge superseded package",
    });

    expect(await count(f.sql, "tf_form_install_events")).toBe(2);
    expect(await count(f.sql, "tf_form_package_purge_events")).toBe(2);
    const installHead = await f.host.inspect({
      kind: "Package",
      formRef: FORM_REF,
      packageDigest: replacement.packageDigest,
    });
    expect(installHead.install).toMatchObject({ package_digest: replacement.packageDigest });
    expect(
      (await f.objects.list({ prefix: `${formPackagePrefix(f.pkg.packageDigest)}/`, limit: 100 }))
        .objects,
    ).toHaveLength(0);
    expect(
      (
        await f.objects.list({
          prefix: `${formPackagePrefix(replacement.packageDigest)}/`,
          limit: 100,
        })
      ).objects.length,
    ).toBeGreaterThan(0);
  });

  test("support and explicit host activation are independent append-only events", async () => {
    const f = await fixture();
    await f.host.execute({
      kind: "InstallPackage",
      package: f.pkg,
      handle: f.handle,
      actor: "test-operator",
      reason: "install package",
    });
    const implementationDigest = digest("8");
    const support = await f.host.execute({
      kind: "SetSupport",
      formRef: FORM_REF,
      packageDigest: f.pkg.packageDigest,
      supported: true,
      profile: { apiVersion: "support.takoform.com/v1alpha1" },
      operations: ["read"],
      implementationDigest,
      actor: "test-operator",
      reason: "support package",
    });
    expect(support.state).toBe("supported");

    const activation = await f.host.execute({
      kind: "SetActivation",
      formRef: FORM_REF,
      packageDigest: f.pkg.packageDigest,
      active: true,
      audience: { kind: "host", value: "host" },
      implementationDigest,
      actor: "test-operator",
      reason: "activate package",
    });
    expect(activation.state).toBe("active");
    expect(await count(f.sql, "tf_form_support_events")).toBe(1);
    expect(await count(f.sql, "tf_form_activation_events")).toBe(1);

    await expect(
      f.host.execute({
        kind: "SetActivation",
        formRef: FORM_REF,
        packageDigest: f.pkg.packageDigest,
        active: true,
        audience: { kind: "tenant", value: "tenant-a" },
        implementationDigest: digest("9"),
        actor: "test-operator",
        reason: "mismatched implementation",
      }),
    ).rejects.toMatchObject({ code: "admission_conflict" });
  });

  test("activation predecessor fence lets only one concurrent activation win", async () => {
    const f = await fixture();
    await f.host.execute({
      kind: "InstallPackage",
      package: f.pkg,
      handle: f.handle,
      actor: "test-operator",
      reason: "install package",
    });
    const implementationDigest = digest("8");
    await f.host.execute({
      kind: "SetSupport",
      formRef: FORM_REF,
      packageDigest: f.pkg.packageDigest,
      supported: true,
      profile: { apiVersion: "support.takoform.com/v1alpha1" },
      operations: ["read"],
      implementationDigest,
      actor: "test-operator",
      reason: "support package",
    });

    const commands = [0, 1].map(() =>
      f.host.execute({
        kind: "SetActivation" as const,
        formRef: FORM_REF,
        packageDigest: f.pkg.packageDigest,
        active: true,
        audience: { kind: "host" as const, value: "host" },
        implementationDigest,
        actor: "test-operator",
        reason: "concurrent activation",
      }),
    );
    const results = await Promise.allSettled(commands);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(await count(f.sql, "tf_form_activation_events")).toBe(1);
  });

  test("official-like and external values share one shape and no official field", async () => {
    const f = await fixture();
    const external = await f.host.inspect({ kind: "Publisher", publisherKey: "pub" });
    await f.host.execute({
      kind: "AllowPublisher",
      publisher: publisher({ publisherKey: "official-like", identity: "official-like" }),
      actor: "test-operator",
      reason: "shape check",
    });
    const officialLike = await f.host.inspect({ kind: "Publisher", publisherKey: "official-like" });
    const externalKeys = Object.keys(external.publisher ?? {}).sort();
    const officialLikeKeys = Object.keys(officialLike.publisher ?? {}).sort();
    expect(officialLikeKeys).toEqual(externalKeys);
    const values = JSON.stringify({ external, officialLike });
    expect(values).not.toContain('"official"');
    expect(values).not.toContain('"lane"');
  });

  test("purge refuses while support references the package", async () => {
    const f = await fixture();
    await f.host.execute({
      kind: "InstallPackage",
      package: f.pkg,
      handle: f.handle,
      actor: "test-operator",
      reason: "install package",
    });
    await f.host.execute({
      kind: "SetSupport",
      formRef: FORM_REF,
      packageDigest: f.pkg.packageDigest,
      supported: true,
      profile: { apiVersion: "support.takoform.com/v1alpha1" },
      operations: ["read"],
      implementationDigest: digest("8"),
      actor: "test-operator",
      reason: "support package",
    });
    await f.host.execute({
      kind: "UninstallPackage",
      formRef: FORM_REF,
      packageDigest: f.pkg.packageDigest,
      actor: "test-operator",
      reason: "uninstall before support-reference purge",
    });

    await expect(
      f.host.execute({
        kind: "PurgePackage",
        formRef: FORM_REF,
        packageDigest: f.pkg.packageDigest,
        actor: "test-operator",
        reason: "purge referenced package",
      }),
    ).rejects.toMatchObject({ code: "package_references_exist" });
    expect(await count(f.sql, "tf_form_install_events")).toBe(2);
    expect(
      (await f.objects.list({ prefix: `${formPackagePrefix(f.pkg.packageDigest)}/`, limit: 100 }))
        .objects.length,
    ).toBeGreaterThan(0);
  });

  test("purge refuses a Resource whose installed form references the package", async () => {
    const f = await fixture();
    await f.host.execute({
      kind: "InstallPackage",
      package: f.pkg,
      handle: f.handle,
      actor: "test-operator",
      reason: "install package",
    });
    await f.sql.run(
      `INSERT INTO tf_resources
         (tenant_id, space, api_version, kind, name, uid, generation, revision,
          resource_json, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "tenant-a",
        "default",
        FORM_REF.apiVersion,
        FORM_REF.kind,
        "resource-a",
        "resource_uid_a",
        "1",
        "rev-a",
        JSON.stringify({
          form: {
            formRef: FORM_REF,
            packageDigest: f.pkg.packageDigest,
          },
        }),
        1,
      ],
    );

    await f.host.execute({
      kind: "UninstallPackage",
      formRef: FORM_REF,
      packageDigest: f.pkg.packageDigest,
      actor: "test-operator",
      reason: "uninstall before Resource-reference purge",
    });

    await expect(
      f.host.execute({
        kind: "PurgePackage",
        formRef: FORM_REF,
        packageDigest: f.pkg.packageDigest,
        actor: "test-operator",
        reason: "purge referenced package",
      }),
    ).rejects.toMatchObject({ code: "package_references_exist" });
    expect(await count(f.sql, "tf_form_install_events")).toBe(2);
  });

  test("purge is a pending then purged forward-repairable chain", async () => {
    const f = await fixture();
    await f.host.execute({
      kind: "InstallPackage",
      package: f.pkg,
      handle: f.handle,
      actor: "test-operator",
      reason: "install package",
    });
    await f.host.execute({
      kind: "UninstallPackage",
      formRef: FORM_REF,
      packageDigest: f.pkg.packageDigest,
      actor: "test-operator",
      reason: "uninstall before purge",
    });

    const purged = await f.host.execute({
      kind: "PurgePackage",
      formRef: FORM_REF,
      packageDigest: f.pkg.packageDigest,
      actor: "test-operator",
      reason: "purge package",
    });
    expect(purged.state).toBe("purged");
    expect(await count(f.sql, "tf_form_install_events")).toBe(2);
    expect(await count(f.sql, "tf_form_package_purge_events")).toBe(2);
    expect(
      (await f.objects.list({ prefix: `${formPackagePrefix(f.pkg.packageDigest)}/`, limit: 100 }))
        .objects,
    ).toHaveLength(0);

    const repeated = await f.host.execute({
      kind: "PurgePackage",
      formRef: FORM_REF,
      packageDigest: f.pkg.packageDigest,
      actor: "test-operator",
      reason: "retry purge package",
    });
    expect(repeated).toMatchObject({ state: "purged", changed: false });
  });

  test("purge refuses a pending evacuation until its claim is settled", async () => {
    const f = await fixture();
    await f.host.execute({
      kind: "InstallPackage",
      package: f.pkg,
      handle: f.handle,
      actor: "test-operator",
      reason: "install package",
    });
    const implementationDigest = digest("8");
    await insertResource(f.sql, f.pkg.packageDigest, implementationDigest);
    await f.host.execute({
      kind: "BeginEvacuation",
      resourceUid: "resource_uid_a",
      formRef: FORM_REF,
      packageDigest: f.pkg.packageDigest,
      implementationDigest,
      claim: "drain-resource",
      actor: "test-operator",
      reason: "evacuate package",
    });
    await f.host.execute({
      kind: "UninstallPackage",
      formRef: FORM_REF,
      packageDigest: f.pkg.packageDigest,
      actor: "test-operator",
      reason: "uninstall before evacuation-reference purge",
    });

    await expect(
      f.host.execute({
        kind: "PurgePackage",
        formRef: FORM_REF,
        packageDigest: f.pkg.packageDigest,
        actor: "test-operator",
        reason: "purge pending package",
      }),
    ).rejects.toMatchObject({ code: "package_references_exist" });

    await f.host.execute({
      kind: "SettleEvacuation",
      resourceUid: "resource_uid_a",
      state: "settled",
      receipt: { state: "drained" },
      actor: "test-operator",
      reason: "settle evacuation",
    });
    await f.sql.run("DELETE FROM tf_resources WHERE uid = ?", ["resource_uid_a"]);
    const purged = await f.host.execute({
      kind: "PurgePackage",
      formRef: FORM_REF,
      packageDigest: f.pkg.packageDigest,
      actor: "test-operator",
      reason: "purge package",
    });
    expect(purged.state).toBe("purged");
    expect(await count(f.sql, "tf_form_evacuation_events")).toBe(2);
  });

  test("purge respects a live package retention fence", async () => {
    const f = await fixture();
    const retainedPackage = {
      ...(await packageInput()),
      retentionRef: "release-observe-window",
      retentionUntil: Date.now() + 60_000,
    };
    await f.host.execute({
      kind: "InstallPackage",
      package: retainedPackage,
      handle: f.handle,
      actor: "test-operator",
      reason: "install retained package",
    });
    await f.host.execute({
      kind: "UninstallPackage",
      formRef: FORM_REF,
      packageDigest: retainedPackage.packageDigest,
      actor: "test-operator",
      reason: "uninstall before retention-reference purge",
    });

    await expect(
      f.host.execute({
        kind: "PurgePackage",
        formRef: FORM_REF,
        packageDigest: retainedPackage.packageDigest,
        actor: "test-operator",
        reason: "purge retained package",
      }),
    ).rejects.toMatchObject({ code: "package_references_exist" });
    expect(
      (
        await f.objects.list({
          prefix: `${formPackagePrefix(retainedPackage.packageDigest)}/`,
          limit: 100,
        })
      ).objects.length,
    ).toBeGreaterThan(0);
  });

  test("a purge crash leaves pending state that a retry can settle", async () => {
    const objects = createMemoryObjectStore();
    const durablePackages = createFormPackageStore(objects);
    let failOnce = true;
    const packages: FormPackageStore = {
      put: (input) => durablePackages.put(input),
      read: (input) => durablePackages.read(input),
      purge: async (packageDigest) => {
        if (failOnce) {
          failOnce = false;
          throw new Error("simulated object deletion crash");
        }
        await durablePackages.purge(packageDigest);
      },
    };
    const f = await fixture({ objects, packages });
    await f.host.execute({
      kind: "InstallPackage",
      package: f.pkg,
      handle: f.handle,
      actor: "test-operator",
      reason: "install package",
    });
    await f.host.execute({
      kind: "UninstallPackage",
      formRef: FORM_REF,
      packageDigest: f.pkg.packageDigest,
      actor: "test-operator",
      reason: "uninstall before crash purge",
    });

    await expect(
      f.host.execute({
        kind: "PurgePackage",
        formRef: FORM_REF,
        packageDigest: f.pkg.packageDigest,
        actor: "test-operator",
        reason: "crash during purge",
      }),
    ).rejects.toThrow("simulated object deletion crash");
    expect(await count(f.sql, "tf_form_install_events")).toBe(2);
    expect(await count(f.sql, "tf_form_package_purge_events")).toBe(1);

    const repaired = await f.host.execute({
      kind: "PurgePackage",
      formRef: FORM_REF,
      packageDigest: f.pkg.packageDigest,
      actor: "test-operator",
      reason: "repair purge",
    });
    expect(repaired.state).toBe("purged");
    expect(await count(f.sql, "tf_form_install_events")).toBe(2);
    expect(await count(f.sql, "tf_form_package_purge_events")).toBe(2);
    expect(
      (await objects.list({ prefix: `${formPackagePrefix(f.pkg.packageDigest)}/`, limit: 100 }))
        .objects,
    ).toHaveLength(0);
  });

  test("purge succeeds only after support and activation references are settled", async () => {
    const f = await fixture();
    await f.host.execute({
      kind: "InstallPackage",
      package: f.pkg,
      handle: f.handle,
      actor: "test-operator",
      reason: "install package",
    });
    const implementationDigest = digest("8");
    await f.host.execute({
      kind: "SetSupport",
      formRef: FORM_REF,
      packageDigest: f.pkg.packageDigest,
      supported: true,
      profile: { apiVersion: "support.takoform.com/v1alpha1" },
      operations: ["read"],
      implementationDigest,
      actor: "test-operator",
      reason: "support package",
    });
    await f.host.execute({
      kind: "SetActivation",
      formRef: FORM_REF,
      packageDigest: f.pkg.packageDigest,
      active: true,
      audience: { kind: "host", value: "host" },
      implementationDigest,
      actor: "test-operator",
      reason: "activate package",
    });
    await f.host.execute({
      kind: "UninstallPackage",
      formRef: FORM_REF,
      packageDigest: f.pkg.packageDigest,
      actor: "test-operator",
      reason: "uninstall before reference purge",
    });

    await expect(
      f.host.execute({
        kind: "PurgePackage",
        formRef: FORM_REF,
        packageDigest: f.pkg.packageDigest,
        actor: "test-operator",
        reason: "purge referenced package",
      }),
    ).rejects.toMatchObject({ code: "package_references_exist" });

    await f.host.execute({
      kind: "SetActivation",
      formRef: FORM_REF,
      packageDigest: f.pkg.packageDigest,
      active: false,
      audience: { kind: "host", value: "host" },
      implementationDigest,
      actor: "test-operator",
      reason: "deactivate package",
    });
    await f.host.execute({
      kind: "SetSupport",
      formRef: FORM_REF,
      packageDigest: f.pkg.packageDigest,
      supported: false,
      profile: { apiVersion: "support.takoform.com/v1alpha1" },
      operations: ["read"],
      implementationDigest,
      actor: "test-operator",
      reason: "unsupport package",
    });

    const purged = await f.host.execute({
      kind: "PurgePackage",
      formRef: FORM_REF,
      packageDigest: f.pkg.packageDigest,
      actor: "test-operator",
      reason: "purge package",
    });
    expect(purged.state).toBe("purged");
    expect(await count(f.sql, "tf_form_install_events")).toBe(2);
    expect(await count(f.sql, "tf_form_package_purge_events")).toBe(2);
    expect(await count(f.sql, "tf_form_support_events")).toBe(2);
    expect(await count(f.sql, "tf_form_activation_events")).toBe(2);
    expect(
      (await f.objects.list({ prefix: `${formPackagePrefix(f.pkg.packageDigest)}/`, limit: 100 }))
        .objects,
    ).toHaveLength(0);
  });

  test("private package keys stay separate from generic art keys", async () => {
    const f = await fixture();
    await f.objects.put("art/generic", new TextEncoder().encode("artifact"));
    await f.host.execute({
      kind: "InstallPackage",
      package: f.pkg,
      handle: f.handle,
      actor: "test-operator",
      reason: "install package",
    });

    expect(await f.objects.head("art/generic")).not.toBeNull();
    expect(
      (await f.objects.list({ prefix: "art/", limit: 100 })).objects.map((object) => object.key),
    ).toEqual(["art/generic"]);
    expect(
      (await f.objects.list({ prefix: `${formPackagePrefix(f.pkg.packageDigest)}/`, limit: 100 }))
        .objects.length,
    ).toBeGreaterThan(0);
  });

  test("custom package manifests are closed and reject authority or unknown fields", async () => {
    const f = await fixture();
    const base = await packageInput();
    const malicious = {
      ...(base.manifest ?? {}),
      official: true,
    };
    const maliciousDigest = (await canonicalDigest(malicious)) as AdmissionDigest;
    await expect(
      f.packages.put({
        ...base,
        manifest: malicious,
        packageDigest: maliciousDigest,
      }),
    ).rejects.toMatchObject({ code: "invalid_package" });

    const unknown = {
      ...(base.manifest ?? {}),
      authority: { mode: "operator" },
    };
    const unknownDigest = (await canonicalDigest(unknown)) as AdmissionDigest;
    await expect(
      f.packages.put({
        ...base,
        manifest: unknown,
        packageDigest: unknownDigest,
      }),
    ).rejects.toMatchObject({ code: "invalid_package" });
  });

  test("evacuation requires an existing Resource with exact Form/package/implementation identity", async () => {
    const f = await fixture();
    await f.host.execute({
      kind: "InstallPackage",
      package: f.pkg,
      handle: f.handle,
      actor: "test-operator",
      reason: "install package",
    });
    const implementationDigest = digest("8");
    await expect(
      f.host.execute({
        kind: "BeginEvacuation",
        resourceUid: "missing_resource",
        formRef: FORM_REF,
        packageDigest: f.pkg.packageDigest,
        implementationDigest,
        claim: "drain-resource",
        actor: "test-operator",
        reason: "missing resource",
      }),
    ).rejects.toMatchObject({ code: "admission_conflict" });

    await insertResource(f.sql, f.pkg.packageDigest, digest("9"));
    await expect(
      f.host.execute({
        kind: "BeginEvacuation",
        resourceUid: "resource_uid_a",
        formRef: FORM_REF,
        packageDigest: f.pkg.packageDigest,
        implementationDigest,
        claim: "drain-resource",
        actor: "test-operator",
        reason: "mismatched resource",
      }),
    ).rejects.toMatchObject({ code: "admission_conflict" });

    await f.sql.run("DELETE FROM tf_resources WHERE uid = ?", ["resource_uid_a"]);
    await insertResource(f.sql, f.pkg.packageDigest, implementationDigest);
    const begun = await f.host.execute({
      kind: "BeginEvacuation",
      resourceUid: "resource_uid_a",
      formRef: FORM_REF,
      packageDigest: f.pkg.packageDigest,
      implementationDigest,
      claim: "drain-resource",
      actor: "test-operator",
      reason: "matching resource",
    });
    expect(begun.state).toBe("pending");
  });
});
