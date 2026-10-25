import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  auth103NativeTargetRef,
  compileAuth103NativeSourceInstallContribution,
  createAuth103CanonicalSourceArtifacts,
} from "../scripts/deploy/auth103-native-source.ts";
import { readFinancial0104CanonicalMigrationSource } from "../scripts/deploy/financial0104-canonical-source.ts";
import { compileRoot0105ImportShapes } from "../scripts/deploy/financial0104-schema-shape.ts";
import { REPOSITORY } from "../scripts/deploy/process.ts";
import {
  AUTH103_CURRENT_RUNTIME_DEPLOYED_SOURCE_PATHS,
  assertAuth103CurrentRuntimeApplyAllowed,
  assertAuth103CurrentRuntimePairAck,
  assertAuth103CurrentRuntimePostimageRows,
  assertAuth103CurrentRuntimeThirdCustodyEntries,
  auth103CurrentRuntimeRegistrationState,
  auth103CurrentRuntimeRpReference,
  auth103NativePairPredicate,
  compileAuth103CurrentRuntimePairSql,
  compileAuth103CurrentRuntimePostimageStatements,
  exactAuth103CurrentRuntimeInstalledCustody,
  exactCurrentAuth103NativePair,
  finalizeAuth103CurrentRuntimeDispatchedCustody,
  readSealedAuth103CustodyJson,
  selectAuth103CurrentRuntimeSuccessorSlot,
} from "../scripts/deploy/schema-auth103-current-runtime-registration.ts";
import { boundCurrentPredicate } from "../scripts/deploy/schema-auth103-native-source.ts";
import {
  AUTH103_NATIVE_INSTALL_DDL,
  AUTH103_NATIVE_PROFILE,
  type Auth103NativeSourceManifest,
  auth103RpRegistrationRecord,
} from "../src/auth103-native-source-contract.ts";
import { canonicalJson } from "../src/json.ts";
import { SHARED_AUTH_STAGING_PROFILE } from "../src/shared-auth-oidc-client.ts";
import { frameHostMigrationSql } from "../src/sqlite-migration-policy.ts";

const digest = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const reference = (value: string) => `sha256:${digest(value)}` as const;
const SOURCE_COMMIT = "0123456789abcdef0123456789abcdef01234567";

function manifestFor(sourceCommit: string): Auth103NativeSourceManifest {
  const canonical = createAuth103CanonicalSourceArtifacts(REPOSITORY);
  const sourceScratch = mkdtempSync(join(tmpdir(), "auth103-runtime-registration-fixture-"));
  const sourceFixture = readFinancial0104CanonicalMigrationSource(REPOSITORY, sourceScratch);
  const authSchemaRef = sourceFixture.auth103.digest;
  const shapes = compileRoot0105ImportShapes(
    sourceFixture.auth103,
    sourceFixture.artifact,
    sourceFixture.artifact105,
    "ordinary",
  );
  const catalogProjection = shapes.auth103Catalog.map(
    (entry) =>
      [
        catalogField(entry, "type"),
        catalogField(entry, "name"),
        catalogField(entry, "tbl_name"),
      ] as const,
  );
  sourceFixture.dispose();
  const partial: Auth103NativeSourceManifest = {
    version: 1,
    sourceCommit,
    targetRef: auth103NativeTargetRef({
      accountId: "local-test-account",
      d1: { databaseName: "local-test-database", databaseId: "local-test-database" },
    }),
    authSchemaRef,
    registrationRef: canonical.registrationRef,
    recipeDigest: canonical.recipeDigest,
    clockSourceDigest: canonical.clockSourceDigest,
    clockPolicyRef: canonical.clockPolicyRef,
    sourceRef: canonical.registrationRef,
    catalogDigest: reference(canonicalJson(catalogProjection)),
    catalogProjection,
    rpRegistration: {
      registrationRef: canonical.registrationRef,
      registrationDigest: canonical.recipeDigest,
      receiptRef: canonical.clockSourceDigest,
      issuerSourceRef: canonical.clockPolicyRef,
      configDigest:
        "sha256:" +
        createHash("sha256").update(canonicalJson(SHARED_AUTH_STAGING_PROFILE)).digest("hex"),
      profile: SHARED_AUTH_STAGING_PROFILE,
    },
  };
  const rpRecord = auth103RpRegistrationRecord(partial);
  return {
    ...partial,
    rpRegistration: {
      registrationRef: rpRecord.registrationRef,
      registrationDigest: rpRecord.registrationDigest,
      receiptRef: rpRecord.receiptRef,
      issuerSourceRef: rpRecord.issuerSourceRef,
      configDigest: rpRecord.configDigest,
      profile: rpRecord.profile,
    },
  };
}

function currentPair(
  manifest: Auth103NativeSourceManifest,
  sourceProfile: "ordinary" | "money-preserved" = "money-preserved",
) {
  expect(canonicalJson(manifest.rpRegistration.profile)).toBe(
    canonicalJson(SHARED_AUTH_STAGING_PROFILE),
  );
  const worker = Buffer.from(
    `let define_TAKOSERVER_AUTH103_NATIVE_SOURCE_default;\nlet define_TAKOSERVER_AUTH103_NATIVE_PROFILE_default;\ndefine_TAKOSERVER_AUTH103_NATIVE_SOURCE_default = ${canonicalJson(manifest)};\ndefine_TAKOSERVER_AUTH103_NATIVE_PROFILE_default = ${canonicalJson({ profile: AUTH103_NATIVE_PROFILE, sourceProfile })};`,
    "utf8",
  );
  const bundleDigest = digest(worker);
  const install = Buffer.from(
    compileAuth103NativeSourceInstallContribution(
      manifest,
      `sha256:${bundleDigest}`,
      sourceProfile,
    ),
    "utf8",
  );
  const response = {
    main_module: "worker.js",
    modules: [
      {
        name: "worker.js",
        content_type: "application/javascript+module",
        content_base64: worker.toString("base64"),
      },
      {
        name: "auth103-source-install.sql",
        content_type: "text/plain",
        content_base64: install.toString("base64"),
      },
    ],
  };
  return {
    response,
    pair: exactCurrentAuth103NativePair(response, manifest.sourceCommit, bundleDigest),
  };
}

function changedRpManifest(sourceCommit: string): Auth103NativeSourceManifest {
  const manifest = manifestFor(sourceCommit);
  return {
    ...manifest,
    rpRegistration: {
      ...manifest.rpRegistration,
      registrationRef: reference("callback-rp-registration-ref"),
      registrationDigest: reference("callback-rp-registration-digest"),
      receiptRef: reference("callback-rp-registration-receipt"),
      issuerSourceRef: reference("callback-issuer-source"),
    },
  };
}

function pairInsertTargets(sql: string): readonly string[] {
  return frameHostMigrationSql(sql)
    .map(
      (statement) =>
        /^\s*INSERT\s+INTO\s+(?:"|`)?([A-Za-z_][A-Za-z0-9_]*)(?:"|`)?/i.exec(statement)?.[1],
    )
    .filter((target): target is string => target !== undefined);
}

test("current runtime source and install are one exact commit and artifact pair", () => {
  const currentManifest = manifestFor(SOURCE_COMMIT);
  const historicalManifest = manifestFor("fedcba9876543210fedcba9876543210fedcba98");
  const current = currentPair(currentManifest);
  const historical = currentPair(historicalManifest);
  expect(current.pair.manifest.sourceCommit).toBe(SOURCE_COMMIT);
  expect(current.pair.bundleDigest).not.toBe(historical.pair.bundleDigest);
  expect(current.pair.sourceProfile).toBe("money-preserved");
  expect(current.pair.record.rpJson).toBe(historical.pair.record.rpJson);
  expect(current.pair.manifest.rpRegistration).toEqual(historical.pair.manifest.rpRegistration);
  expect(() =>
    exactCurrentAuth103NativePair(
      current.response,
      "f".repeat(40),
      current.pair.bundleDigest.slice(7),
    ),
  ).toThrow();

  const ordinary = currentPair(currentManifest, "ordinary");
  expect(ordinary.pair.sourceProfile).toBe("ordinary");
  const ordinaryWorker = ordinary.response.modules[0];
  if (!ordinaryWorker) throw new Error("fixture worker module is incomplete");
  const ordinarySource = Buffer.from(ordinaryWorker.content_base64, "base64").toString("utf8");
  const profileAssignment = `define_TAKOSERVER_AUTH103_NATIVE_PROFILE_default = ${canonicalJson({ profile: AUTH103_NATIVE_PROFILE, sourceProfile: "ordinary" })};`;
  expect(ordinarySource.includes(profileAssignment)).toBe(true);
  const withWorkerSource = (source: string) => ({
    ...ordinary.response,
    modules: [
      { ...ordinaryWorker, content_base64: Buffer.from(source).toString("base64") },
      ordinary.response.modules[1],
    ],
  });
  const mismatchedWorker = ordinarySource.replace(
    '"sourceProfile":"ordinary"',
    '"sourceProfile":"money-preserved"',
  );
  const mismatchDigest = digest(mismatchedWorker);
  expect(() =>
    exactCurrentAuth103NativePair(
      withWorkerSource(mismatchedWorker),
      currentManifest.sourceCommit,
      mismatchDigest,
    ),
  ).toThrow();
  const withoutProfile = ordinarySource.replace(profileAssignment, "");
  expect(() =>
    exactCurrentAuth103NativePair(
      withWorkerSource(withoutProfile),
      currentManifest.sourceCommit,
      digest(withoutProfile),
    ),
  ).toThrow();
  const ambiguousProfile = `${ordinarySource}\n${profileAssignment}`;
  expect(() =>
    exactCurrentAuth103NativePair(
      withWorkerSource(ambiguousProfile),
      currentManifest.sourceCommit,
      digest(ambiguousProfile),
    ),
  ).toThrow();
  const unknownProfile = ordinarySource.replace(
    '"sourceProfile":"ordinary"',
    '"sourceProfile":"other"',
  );
  expect(() =>
    exactCurrentAuth103NativePair(
      withWorkerSource(unknownProfile),
      currentManifest.sourceCommit,
      digest(unknownProfile),
    ),
  ).toThrow();
  expect(() =>
    exactCurrentAuth103NativePair(current.response, SOURCE_COMMIT, "0".repeat(64)),
  ).toThrow();

  const currentWorker = current.response.modules[0];
  const historicalInstall = historical.response.modules[1];
  if (!currentWorker || !historicalInstall) throw new Error("fixture module pair is incomplete");
  const crossed = {
    main_module: current.response.main_module,
    modules: [currentWorker, historicalInstall],
  };
  expect(() =>
    exactCurrentAuth103NativePair(crossed, SOURCE_COMMIT, current.pair.bundleDigest.slice(7)),
  ).toThrow();
  expect(() =>
    exactCurrentAuth103NativePair(
      { main_module: current.response.main_module, modules: [currentWorker] },
      SOURCE_COMMIT,
      current.pair.bundleDigest.slice(7),
    ),
  ).toThrow();
});

test("compiler emits only the new current pair against canonical schema guards", () => {
  const scratchBase = mkdtempSync(join(tmpdir(), "auth103-current-registration-"));
  const registered = readFinancial0104CanonicalMigrationSource(REPOSITORY, scratchBase);
  try {
    const current = currentPair(manifestFor(SOURCE_COMMIT)).pair;
    const historical = currentPair(manifestFor("fedcba9876543210fedcba9876543210fedcba98")).pair;
    const shapes = compileRoot0105ImportShapes(
      registered.auth103,
      registered.artifact,
      registered.artifact105,
      "ordinary",
    );
    const currentSourcePredicate = boundCurrentPredicate(
      [
        current.manifest.registrationRef,
        current.manifest.recipeDigest,
        current.manifest.clockSourceDigest,
        current.manifest.clockPolicyRef,
      ],
      JSON.stringify(shapes.auth103Catalog),
    );
    const compiled = compileAuth103CurrentRuntimePairSql({
      current,
      historical,
      migrationNames: registered.artifact105.names,
      postShape: shapes.postShape,
      currentSourcePredicate,
    });
    const targets = pairInsertTargets(compiled.sql);
    expect([...targets]).toHaveLength(2);
    expect(new Set(targets).size).toBe(2);
    const frames = frameHostMigrationSql(compiled.sql);
    expect(frames.length).toBeGreaterThan(0);
    const oversized = frames
      .map((statement, index) => ({ index, bytes: Buffer.byteLength(statement, "utf8") }))
      .filter(({ bytes }) => bytes >= 100_000);
    expect(oversized).toEqual([]);
    expect(compiled.guardCount).toBeGreaterThan(0);
    expect(compiled.postGuardCount).toBeGreaterThan(0);

    const changedManifest = changedRpManifest(SOURCE_COMMIT);
    const changed = currentPair(changedManifest).pair;
    const successor = compileAuth103CurrentRuntimePairSql({
      current: changed,
      historical,
      migrationNames: registered.artifact105.names,
      postShape: shapes.postShape,
      currentSourcePredicate,
    });
    expect(successor.rpAdded).toBe(true);
    expect(pairInsertTargets(successor.sql)).toEqual([
      "auth103_native_rp_registrations",
      "auth103_native_rp_registration_receipts",
      "auth103_native_deployments",
      "auth103_native_deployment_receipts",
    ]);
    expect(
      frameHostMigrationSql(successor.sql).every(
        (statement) => Buffer.byteLength(statement, "utf8") < 100_000,
      ),
    ).toBe(true);
    expect(() =>
      compileAuth103CurrentRuntimePairSql({
        current: currentPair({
          ...manifestFor(SOURCE_COMMIT),
          rpRegistration: {
            ...manifestFor(SOURCE_COMMIT).rpRegistration,
            registrationDigest: reference("collision-with-historical-ref"),
          },
        }).pair,
        historical,
        migrationNames: registered.artifact105.names,
        postShape: shapes.postShape,
        currentSourcePredicate,
      }),
    ).toThrow();

    const database = new Database(":memory:");
    try {
      database.exec(AUTH103_NATIVE_INSTALL_DDL);
      for (const statement of frameHostMigrationSql(
        compileAuth103NativeSourceInstallContribution(
          historical.manifest,
          historical.bundleDigest,
          historical.sourceProfile,
        ),
      ))
        database.query(statement).all();
      const count = (table: string) =>
        (database.query(`SELECT count(*) AS amount FROM ${table}`).get() as { amount: number })
          .amount;
      const tables = [
        "auth103_native_rp_registrations",
        "auth103_native_rp_registration_receipts",
        "auth103_native_deployments",
        "auth103_native_deployment_receipts",
      ];
      expect(tables.map(count)).toEqual([1, 1, 1, 1]);
      const inserts = frameHostMigrationSql(successor.sql).filter((statement) =>
        /^\s*INSERT\s+INTO\s+auth103_native_/i.test(statement),
      );
      expect(inserts).toHaveLength(4);
      const inventoryGuard = frameHostMigrationSql(successor.sql).find(
        (statement) =>
          statement.includes("(SELECT count(*) FROM auth103_native_rp_registrations)=1") &&
          statement.includes("(SELECT count(*) FROM auth103_native_deployment_receipts)=1"),
      );
      expect(inventoryGuard).toBeDefined();
      expect(database.query(inventoryGuard!).get()).toEqual({ current: 1 });
      database.exec("BEGIN");
      for (const statement of inserts.slice(0, 2)) database.query(statement).all();
      expect(() => database.query(inventoryGuard!).get()).toThrow();
      database.exec("ROLLBACK");
      expect(tables.map(count)).toEqual([1, 1, 1, 1]);
      database.exec("BEGIN");
      expect(() => {
        for (const statement of inserts) database.query(statement).all();
        database.query("SELECT * FROM auth103_nonexistent_late_guard").all();
      }).toThrow();
      database.exec("ROLLBACK");
      expect(tables.map(count)).toEqual([1, 1, 1, 1]);
      database.exec("BEGIN");
      for (const statement of inserts) database.query(statement).all();
      database.exec("COMMIT");
      expect(tables.map(count)).toEqual([2, 2, 2, 2]);
      expect(
        database
          .query(
            "SELECT record_json FROM auth103_native_rp_registrations WHERE registration_ref = ?",
          )
          .get(historical.record.rp.registrationRef),
      ).toEqual({ record_json: historical.record.rpJson });
      expect(
        database
          .query("SELECT record_json FROM auth103_native_deployments WHERE deployment_ref = ?")
          .get(historical.record.deploymentRef),
      ).toEqual({ record_json: historical.record.deploymentJson });
    } finally {
      database.close();
    }
  } finally {
    registered.dispose();
    rmSync(scratchBase, { recursive: true, force: true });
  }
});

test("D1 multi-result acknowledgement rejects count, status, changes, and guard failures", () => {
  const current = currentPair(manifestFor(SOURCE_COMMIT)).pair;
  const guardCount = 2;
  const historical = currentPair(manifestFor("a".repeat(40))).pair;
  const postGuardCount = 2;
  const deploymentResult = () => ({
    success: true,
    results: [
      {
        deployment_ref: current.record.deploymentRef,
        target_ref: current.manifest.targetRef,
        source_ref: current.manifest.sourceRef,
        artifact_digest: current.bundleDigest,
        record_json: current.record.deploymentJson,
      },
    ],
  });
  const receiptResult = () => ({
    success: true,
    results: [
      {
        receipt_ref: current.record.deploymentReceiptRef,
        deployment_ref: current.record.deploymentRef,
        record_json: current.record.deploymentJson,
      },
    ],
  });
  const guardResult = () => ({ success: true, results: [{ current: 1 }] });
  const changedRowsResult = () => ({ success: true, results: [{ changed_rows: 1 }] });
  const valid = [
    guardResult(),
    guardResult(),
    deploymentResult(),
    changedRowsResult(),
    receiptResult(),
    changedRowsResult(),
    guardResult(),
    guardResult(),
  ];
  const accept = (results: readonly unknown[]) =>
    assertAuth103CurrentRuntimePairAck(
      JSON.stringify(results),
      guardCount,
      current,
      postGuardCount,
      historical,
    );
  expect(() => accept(valid)).not.toThrow();
  expect(() => accept(valid.slice(0, -1))).toThrow();
  expect(() =>
    accept(valid.map((entry, index) => (index === 0 ? { ...entry, success: false } : entry))),
  ).toThrow();
  expect(() =>
    accept(
      valid.map((entry, index) =>
        index === guardCount + 1 ? { success: true, results: [{ changed_rows: 0 }] } : entry,
      ),
    ),
  ).toThrow();
  expect(() =>
    accept(
      valid.map((entry, index) =>
        index === guardCount + 3 ? { success: true, results: [{ changed_rows: 2 }] } : entry,
      ),
    ),
  ).toThrow();
  expect(() =>
    accept(
      valid.map((entry, index) => (index === valid.length - 1 ? { ...entry, results: [] } : entry)),
    ),
  ).toThrow();
  expect(() =>
    accept(
      valid.map((entry, index) =>
        index === guardCount
          ? receiptResult()
          : index === guardCount + 2
            ? deploymentResult()
            : entry,
      ),
    ),
  ).toThrow();
});
test("current-runtime RP successor ACK rejects partial and late results", () => {
  const current = currentPair(changedRpManifest(SOURCE_COMMIT)).pair;
  const historical = currentPair(manifestFor("a".repeat(40))).pair;
  const guardCount = 2;
  const postGuardCount = 2;
  const result = (row: Record<string, unknown>) => ({ success: true, results: [row] });
  const guard = () => result({ current: 1 });
  const changed = () => result({ changed_rows: 1 });
  const valid = [
    guard(),
    guard(),
    result({
      registration_ref: current.record.rp.registrationRef,
      registration_digest: current.record.rp.registrationDigest,
      record_json: current.record.rpJson,
    }),
    changed(),
    result({
      receipt_ref: current.record.rp.receiptRef,
      registration_ref: current.record.rp.registrationRef,
      record_json: current.record.rpJson,
    }),
    changed(),
    result({
      deployment_ref: current.record.deploymentRef,
      target_ref: current.manifest.targetRef,
      source_ref: current.manifest.sourceRef,
      artifact_digest: current.bundleDigest,
      record_json: current.record.deploymentJson,
    }),
    changed(),
    result({
      receipt_ref: current.record.deploymentReceiptRef,
      deployment_ref: current.record.deploymentRef,
      record_json: current.record.deploymentJson,
    }),
    changed(),
    guard(),
    guard(),
  ];
  const accept = (entries: readonly unknown[]) =>
    assertAuth103CurrentRuntimePairAck(
      JSON.stringify(entries),
      guardCount,
      current,
      postGuardCount,
      historical,
    );
  expect(() => accept(valid)).not.toThrow();
  expect(() => accept(valid.slice(0, -1))).toThrow();
  expect(() => accept([...valid, guard()])).toThrow();
  expect(() =>
    accept(valid.map((entry, index) => (index === 3 ? result({ changed_rows: 0 }) : entry))),
  ).toThrow();
  expect(() =>
    accept(
      valid.map((entry, index) =>
        index === 2
          ? result({
              registration_ref: historical.record.rp.registrationRef,
              registration_digest: current.record.rp.registrationDigest,
              record_json: current.record.rpJson,
            })
          : entry,
      ),
    ),
  ).toThrow();
  expect(() =>
    accept(
      valid.map((entry, index) => (index === valid.length - 1 ? result({ current: 0 }) : entry)),
    ),
  ).toThrow();
});

test("third runtime custody preserves partial history and rejects unknown entries", () => {
  const scratch = mkdtempSync(join(tmpdir(), "auth103-third-custody-"));
  const bridge = join(scratch, "auth103-current-runtime-registration-v3");
  try {
    mkdirSync(bridge, { mode: 0o700 });
    const dispatch = join(bridge, "dispatch.json");
    const installed = join(bridge, "installed.json");
    const foreign = join(bridge, "foreign.json");
    writeFileSync(dispatch, "sealed", { mode: 0o600 });
    expect(assertAuth103CurrentRuntimeThirdCustodyEntries(bridge)).toBe("dispatched");
    writeFileSync(foreign, "unknown", { mode: 0o600 });
    expect(() => assertAuth103CurrentRuntimeThirdCustodyEntries(bridge)).toThrow();
    rmSync(foreign);
    writeFileSync(installed, "sealed", { mode: 0o600 });
    expect(assertAuth103CurrentRuntimeThirdCustodyEntries(bridge)).toBe("installed");
    writeFileSync(foreign, "unknown", { mode: 0o600 });
    expect(() => assertAuth103CurrentRuntimeThirdCustodyEntries(bridge)).toThrow();
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("installed current-runtime status uses the sealed tool original while rejecting altered custody", () => {
  const historicalTool = "8".repeat(40);
  const currentTool = "b".repeat(40);
  const currentMarker = {
    kind: "takoserver.auth103-current-runtime-registration-dispatch@v1",
    environment: "integration",
    toolCommit: currentTool,
    deployedCommit: "0".repeat(40),
    versionId: "version-original",
    deploymentId: "deployment-original",
    artifactDigest: reference("artifact-original"),
    targetRef: reference("target-original"),
    sourceRef: reference("source-original"),
    deploymentRef: reference("deployment-ref-original"),
    receiptRef: reference("receipt-ref-original"),
    sqlDigest: reference("sql-original"),
    targetDigest: reference("target-json-original"),
    historicalReceiptDigest: reference("history-original"),
    publicationStatusDigest: reference("publication-original"),
    predecessorMarkerDigest: reference("prior-marker-original"),
    predecessorInstalledDigest: reference("prior-installed-original"),
    predecessorDeploymentRef: reference("prior-deployment-original"),
  };
  const historicalMarker = { ...currentMarker, toolCommit: historicalTool };
  const sealed = (value: object) => reference(`${JSON.stringify(value, null, 2)}\n`);
  const markerDigest = sealed(historicalMarker);
  const savedMarker = { value: historicalMarker, digest: markerDigest };
  const savedInstalled = {
    digest: sealed({
      ...historicalMarker,
      kind: "takoserver.auth103-current-runtime-registration-installed@v1",
      markerDigest,
    }),
  };
  expect(currentMarker.toolCommit).not.toBe(historicalTool);
  expect(
    exactAuth103CurrentRuntimeInstalledCustody(currentMarker, savedMarker, savedInstalled),
  ).toBe(true);
  for (const changed of [
    { ...currentMarker, sourceRef: reference("different-source") },
    { ...currentMarker, versionId: "different-version" },
    { ...currentMarker, sqlDigest: reference("different-sql") },
    { ...currentMarker, extra: "foreign" },
  ]) {
    expect(exactAuth103CurrentRuntimeInstalledCustody(changed, savedMarker, savedInstalled)).toBe(
      false,
    );
  }
  expect(
    exactAuth103CurrentRuntimeInstalledCustody(currentMarker, savedMarker, {
      digest: reference("altered-installed"),
    }),
  ).toBe(false);
  expect(
    exactAuth103CurrentRuntimeInstalledCustody(
      currentMarker,
      { ...savedMarker, value: { ...historicalMarker, toolCommit: "not-a-commit" } },
      savedInstalled,
    ),
  ).toBe(false);
});

function catalogField(entry: unknown, key: string): string {
  const value = entry !== null && typeof entry === "object" ? Reflect.get(entry, key) : undefined;
  if (typeof value !== "string" || value.length === 0)
    throw new Error("invalid canonical catalog projection field");
  return value;
}

test("a sealed prior runtime pair permits only the exact third-generation append", () => {
  const scratch = mkdtempSync(join(tmpdir(), "auth103-third-generation-"));
  const registered = readFinancial0104CanonicalMigrationSource(REPOSITORY, scratch);
  const database = new Database(":memory:");
  try {
    const historical = currentPair(manifestFor("1".repeat(40))).pair;
    const predecessor = currentPair({
      ...manifestFor("2".repeat(40)),
      sourceRef: reference("sealed-first-runtime-source"),
    }).pair;
    const current = currentPair({
      ...changedRpManifest("3".repeat(40)),
      sourceRef: reference("current-runtime-source"),
    }).pair;
    const shapes = compileRoot0105ImportShapes(
      registered.auth103,
      registered.artifact,
      registered.artifact105,
      "ordinary",
    );
    const currentSourcePredicate = boundCurrentPredicate(
      [
        current.manifest.registrationRef,
        current.manifest.recipeDigest,
        current.manifest.clockSourceDigest,
        current.manifest.clockPolicyRef,
      ],
      JSON.stringify(shapes.auth103Catalog),
    );
    const common = {
      historical,
      migrationNames: registered.artifact105.names,
      postShape: shapes.postShape,
      currentSourcePredicate,
    };
    const first = compileAuth103CurrentRuntimePairSql({ ...common, current: predecessor });
    expect(digest(first.sql)).toBe(
      "2a87518c8543418374a887b73757dc96108e1907623a61bc4739a6fd01f226e7",
    );
    const third = compileAuth103CurrentRuntimePairSql({
      ...common,
      current,
      predecessor,
    });
    const fourth = currentPair({
      ...changedRpManifest("d".repeat(40)),
      sourceRef: reference("fourth-runtime-source"),
    }).pair;
    const fourthSourcePredicate = boundCurrentPredicate(
      [
        fourth.manifest.registrationRef,
        fourth.manifest.recipeDigest,
        fourth.manifest.clockSourceDigest,
        fourth.manifest.clockPolicyRef,
      ],
      JSON.stringify(shapes.auth103Catalog),
    );
    const fourthCompiled = compileAuth103CurrentRuntimePairSql({
      ...common,
      current: fourth,
      predecessor: current,
      earlierPredecessor: predecessor,
      currentSourcePredicate: fourthSourcePredicate,
    });
    expect(pairInsertTargets(fourthCompiled.sql)).toEqual([
      "auth103_native_deployments",
      "auth103_native_deployment_receipts",
    ]);
    const nextRpManifest = changedRpManifest("e".repeat(40));
    const nextRpPair = currentPair({
      ...nextRpManifest,
      sourceRef: reference("new-rp-runtime-source"),
      rpRegistration: {
        ...nextRpManifest.rpRegistration,
        registrationRef: reference("new-rp-registration"),
        registrationDigest: reference("new-rp-digest"),
        receiptRef: reference("new-rp-receipt"),
        issuerSourceRef: reference("new-rp-issuer"),
      },
    }).pair;
    const nextRpCompiled = compileAuth103CurrentRuntimePairSql({
      ...common,
      current: nextRpPair,
      predecessor: current,
      earlierPredecessor: predecessor,
    });
    expect(pairInsertTargets(nextRpCompiled.sql)).toEqual([
      "auth103_native_rp_registrations",
      "auth103_native_rp_registration_receipts",
      "auth103_native_deployments",
      "auth103_native_deployment_receipts",
    ]);
    const fifth = currentPair({
      ...changedRpManifest(digest("auth103-v4-source").slice(0, 40)),
      sourceRef: reference(digest("auth103-v4-source-ref")),
      rpRegistration: nextRpPair.manifest.rpRegistration,
    }).pair;
    const fifthPredicate = boundCurrentPredicate(
      [
        fifth.manifest.registrationRef,
        fifth.manifest.recipeDigest,
        fifth.manifest.clockSourceDigest,
        fifth.manifest.clockPolicyRef,
      ],
      JSON.stringify(shapes.auth103Catalog),
    );
    const fifthCommon = {
      ...common,
      predecessor: nextRpPair,
      earlierPredecessor: current,
      oldestPredecessor: predecessor,
      currentSourcePredicate: fifthPredicate,
    };
    const fifthCompiled = compileAuth103CurrentRuntimePairSql({
      ...fifthCommon,
      current: fifth,
    });
    expect(fifthCompiled.guardCount).toBe(fourthCompiled.guardCount + 1);
    expect(fifthCompiled.rpAdded).toBe(false);
    expect(pairInsertTargets(fifthCompiled.sql)).toEqual([
      "auth103_native_deployments",
      "auth103_native_deployment_receipts",
    ]);
    expect(
      frameHostMigrationSql(fifthCompiled.sql).every(
        (statement) => Buffer.byteLength(statement) < 100_000,
      ),
    ).toBe(true);
    const newRpManifest = changedRpManifest(digest("auth103-v4-new-rp").slice(0, 40));
    const sixth = currentPair({
      ...newRpManifest,
      sourceRef: reference(digest("auth103-v4-new-rp-source-ref")),
      rpRegistration: {
        ...newRpManifest.rpRegistration,
        registrationRef: reference(digest("auth103-v4-new-rp-ref")),
        registrationDigest: reference(digest("auth103-v4-new-rp-digest")),
        receiptRef: reference(digest("auth103-v4-new-rp-receipt")),
        issuerSourceRef: reference(digest("auth103-v4-new-rp-issuer")),
      },
    }).pair;
    const sixthCompiled = compileAuth103CurrentRuntimePairSql({
      ...fifthCommon,
      current: sixth,
    });
    expect(sixthCompiled.rpAdded).toBe(true);
    expect(pairInsertTargets(sixthCompiled.sql)).toEqual([
      "auth103_native_rp_registrations",
      "auth103_native_rp_registration_receipts",
      "auth103_native_deployments",
      "auth103_native_deployment_receipts",
    ]);
    const seventh = currentPair({
      ...changedRpManifest(digest("auth103-v5-source").slice(0, 40)),
      sourceRef: reference(digest("auth103-v5-source-ref")),
      rpRegistration: sixth.manifest.rpRegistration,
    }).pair;
    const seventhPredicate = boundCurrentPredicate(
      [
        seventh.manifest.registrationRef,
        seventh.manifest.recipeDigest,
        seventh.manifest.clockSourceDigest,
        seventh.manifest.clockPolicyRef,
      ],
      JSON.stringify(shapes.auth103Catalog),
    );
    const seventhCommon = {
      ...common,
      earliestPredecessor: predecessor,
      oldestPredecessor: current,
      earlierPredecessor: nextRpPair,
      predecessor: sixth,
      currentSourcePredicate: seventhPredicate,
    };
    const seventhCompiled = compileAuth103CurrentRuntimePairSql({
      ...seventhCommon,
      current: seventh,
    });
    expect(seventhCompiled.guardCount).toBe(fifthCompiled.guardCount + 1);
    expect(seventhCompiled.rpAdded).toBe(false);
    expect(pairInsertTargets(seventhCompiled.sql)).toEqual([
      "auth103_native_deployments",
      "auth103_native_deployment_receipts",
    ]);
    expect(
      frameHostMigrationSql(seventhCompiled.sql).every(
        (statement) => Buffer.byteLength(statement, "utf8") < 100_000,
      ),
    ).toBe(true);
    const eighthManifest = changedRpManifest(digest("auth103-v5-new-rp").slice(0, 40));
    const eighth = currentPair({
      ...eighthManifest,
      sourceRef: reference(digest("auth103-v5-new-rp-source-ref")),
      rpRegistration: {
        ...eighthManifest.rpRegistration,
        registrationRef: reference(digest("auth103-v5-new-rp-ref")),
        registrationDigest: reference(digest("auth103-v5-new-rp-digest")),
        receiptRef: reference(digest("auth103-v5-new-rp-receipt")),
        issuerSourceRef: reference(digest("auth103-v5-new-rp-issuer")),
      },
    }).pair;
    const eighthCompiled = compileAuth103CurrentRuntimePairSql({
      ...seventhCommon,
      current: eighth,
    });
    expect(eighthCompiled.rpAdded).toBe(true);
    expect(pairInsertTargets(eighthCompiled.sql)).toEqual([
      "auth103_native_rp_registrations",
      "auth103_native_rp_registration_receipts",
      "auth103_native_deployments",
      "auth103_native_deployment_receipts",
    ]);
    expect(() =>
      compileAuth103CurrentRuntimePairSql({
        ...seventhCommon,
        current: seventh,
        earliestPredecessor: current,
      }),
    ).toThrow();
    expect(() =>
      compileAuth103CurrentRuntimePairSql({
        ...seventhCommon,
        current: seventh,
        predecessor: nextRpPair,
      }),
    ).toThrow();
    expect(() =>
      compileAuth103CurrentRuntimePairSql({
        ...common,
        current: fifth,
        predecessor: nextRpPair,
        oldestPredecessor: predecessor,
        currentSourcePredicate: fifthPredicate,
      }),
    ).toThrow();
    expect(() =>
      compileAuth103CurrentRuntimePairSql({
        ...fifthCommon,
        current: fifth,
        oldestPredecessor: current,
      }),
    ).toThrow();
    expect(() =>
      compileAuth103CurrentRuntimePairSql({
        ...fifthCommon,
        current: fifth,
        predecessor: predecessor,
      }),
    ).toThrow();
    expect(() =>
      compileAuth103CurrentRuntimePairSql({
        ...common,
        current: fourth,
        predecessor: current,
        earlierPredecessor: current,
        currentSourcePredicate: fourthSourcePredicate,
      }),
    ).toThrow();
    const frames = frameHostMigrationSql(third.sql);
    expect(frames.every((statement) => Buffer.byteLength(statement, "utf8") < 100_000)).toBe(true);
    expect(pairInsertTargets(third.sql)).toEqual([
      "auth103_native_rp_registrations",
      "auth103_native_rp_registration_receipts",
      "auth103_native_deployments",
      "auth103_native_deployment_receipts",
    ]);
    expect(() =>
      compileAuth103CurrentRuntimePairSql({
        ...common,
        current,
        predecessor: current,
      }),
    ).toThrow();
    expect(() =>
      compileAuth103CurrentRuntimePairSql({
        ...common,
        current,
        predecessor: currentPair(changedRpManifest("4".repeat(40))).pair,
      }),
    ).toThrow();

    database.exec(AUTH103_NATIVE_INSTALL_DDL);
    for (const statement of frameHostMigrationSql(
      compileAuth103NativeSourceInstallContribution(
        historical.manifest,
        historical.bundleDigest,
        historical.sourceProfile,
      ),
    ))
      database.query(statement).all();
    const inserts = (sql: string) =>
      frameHostMigrationSql(sql).filter((statement) =>
        /^\s*INSERT\s+INTO\s+auth103_native_/i.test(statement),
      );
    for (const statement of inserts(first.sql)) database.query(statement).all();
    const count = (table: string) =>
      (database.query(`SELECT count(*) AS amount FROM ${table}`).get() as { amount: number })
        .amount;
    const tables = [
      "auth103_native_rp_registrations",
      "auth103_native_rp_registration_receipts",
      "auth103_native_deployments",
      "auth103_native_deployment_receipts",
    ];
    expect(tables.map(count)).toEqual([1, 1, 2, 2]);
    const inventoryGuard = frames.find(
      (statement) =>
        statement.includes("count(*) FROM auth103_native_rp_registrations)=1") &&
        statement.includes("count(*) FROM auth103_native_deployments)=2"),
    );
    if (!inventoryGuard) throw new Error("inventory guard missing");
    expect(database.query(inventoryGuard).get()).toEqual({ current: 1 });
    const thirdInserts = inserts(third.sql);
    database.exec("BEGIN");
    for (const statement of thirdInserts.slice(0, 2)) database.query(statement).all();
    expect(() => database.query(inventoryGuard).get()).toThrow();
    database.exec("ROLLBACK");
    expect(tables.map(count)).toEqual([1, 1, 2, 2]);

    database.exec("BEGIN");
    for (const statement of thirdInserts) database.query(statement).all();
    const currentPostGuard = frames[third.guardCount + 8];
    if (!currentPostGuard) throw new Error("current postimage guard missing");
    expect(database.query(currentPostGuard).get()).toEqual({ current: 1 });
    const fourthFrames = frameHostMigrationSql(fourthCompiled.sql);
    const fourthPreGuards = fourthFrames.slice(0, fourthCompiled.guardCount);
    const eligibleFourthGuards = fourthPreGuards.filter((statement) => {
      try {
        const row = database.query(statement).get() as { current?: number } | null;
        return row?.current === 1;
      } catch {
        return false;
      }
    });
    const fourthPostGuard = fourthFrames[fourthCompiled.guardCount + 4];
    if (!fourthPostGuard) throw new Error("missing fourth-generation guard");
    expect(eligibleFourthGuards.length).toBeGreaterThan(0);
    const fourthInserts = inserts(fourthCompiled.sql);
    expect(fourthInserts).toHaveLength(2);
    database.exec("SAVEPOINT partial_fourth");
    database.query(fourthInserts[0]!).all();
    expect(
      eligibleFourthGuards.some((statement) => {
        try {
          database.query(statement).get();
          return false;
        } catch {
          return true;
        }
      }),
    ).toBe(true);
    database.exec("ROLLBACK TO partial_fourth");
    database.exec("RELEASE partial_fourth");
    for (const statement of fourthInserts) database.query(statement).all();
    expect(tables.map(count)).toEqual([2, 2, 4, 4]);
    expect(database.query(fourthPostGuard).get()).toEqual({ current: 1 });
    expect(() =>
      database
        .query("UPDATE auth103_native_deployment_receipts SET record_json=? WHERE receipt_ref=?")
        .run("tampered", current.record.deploymentReceiptRef),
    ).toThrow();
    database.exec("ROLLBACK");
    expect(tables.map(count)).toEqual([1, 1, 2, 2]);
    expect(
      database
        .query("SELECT record_json FROM auth103_native_deployments WHERE deployment_ref=?")
        .get(historical.record.deploymentRef),
    ).toEqual({ record_json: historical.record.deploymentJson });
    expect(
      database
        .query("SELECT record_json FROM auth103_native_deployments WHERE deployment_ref=?")
        .get(predecessor.record.deploymentRef),
    ).toEqual({ record_json: predecessor.record.deploymentJson });

    for (const statement of thirdInserts) database.query(statement).all();
    for (const statement of inserts(nextRpCompiled.sql)) database.query(statement).all();
    for (const statement of inserts(sixthCompiled.sql)) database.query(statement).all();
    expect(tables.map(count)).toEqual([4, 4, 5, 5]);
    const priorRows = tables.map((table) =>
      database.query(`SELECT record_json FROM ${table} ORDER BY record_json`).all(),
    );
    const seventhFrames = frameHostMigrationSql(seventhCompiled.sql);
    const seventhPreGuard = seventhFrames.find(
      (statement) =>
        statement.includes("count(*) FROM auth103_native_rp_registrations)=4") &&
        statement.includes("count(*) FROM auth103_native_deployments)=5"),
    );
    if (!seventhPreGuard) throw new Error("next-successor inventory guard missing");
    expect(database.query(seventhPreGuard).get()).toEqual({ current: 1 });
    const seventhInserts = inserts(seventhCompiled.sql);
    expect(seventhInserts).toHaveLength(2);
    const seventhFirstInsert = seventhInserts[0];
    if (!seventhFirstInsert) throw new Error("next-successor deployment insert missing");
    database.exec("BEGIN");
    database.query(seventhFirstInsert).all();
    expect(() => database.query(seventhPreGuard).get()).toThrow();
    database.exec("ROLLBACK");
    expect(tables.map(count)).toEqual([4, 4, 5, 5]);
    expect(
      tables.map((table) =>
        database.query(`SELECT record_json FROM ${table} ORDER BY record_json`).all(),
      ),
    ).toEqual(priorRows);
    const foreign = currentPair({
      ...changedRpManifest(digest("auth103-v5-foreign").slice(0, 40)),
      sourceRef: reference(digest("auth103-v5-foreign-source-ref")),
      rpRegistration: sixth.manifest.rpRegistration,
    }).pair;
    const foreignInserts = inserts(
      compileAuth103NativeSourceInstallContribution(
        foreign.manifest,
        foreign.bundleDigest,
        foreign.sourceProfile,
      ),
    );
    expect(foreignInserts).toHaveLength(4);
    database.exec("BEGIN");
    for (const statement of foreignInserts.slice(2)) database.query(statement).all();
    expect(() => database.query(seventhPreGuard).get()).toThrow();
    database.exec("ROLLBACK");
    expect(tables.map(count)).toEqual([4, 4, 5, 5]);
    expect(
      tables.map((table) =>
        database.query(`SELECT record_json FROM ${table} ORDER BY record_json`).all(),
      ),
    ).toEqual(priorRows);
    database.exec("BEGIN");
    for (const statement of seventhInserts) database.query(statement).all();
    expect(tables.map(count)).toEqual([4, 4, 6, 6]);
    database.exec("ROLLBACK");
    expect(tables.map(count)).toEqual([4, 4, 5, 5]);
    expect(
      tables.map((table) =>
        database.query(`SELECT record_json FROM ${table} ORDER BY record_json`).all(),
      ),
    ).toEqual(priorRows);
  } finally {
    database.close();
    registered.dispose();
    rmSync(scratch, { recursive: true, force: true });
  }
});

function sixthRuntimeLineage(shapes: ReturnType<typeof compileRoot0105ImportShapes>) {
  const historical = currentPair(manifestFor("1".repeat(40))).pair;
  const v1 = currentPair({
    ...manifestFor("2".repeat(40)),
    sourceRef: reference("sealed-first-runtime-source"),
  }).pair;
  const v2 = currentPair({
    ...changedRpManifest("3".repeat(40)),
    sourceRef: reference("current-runtime-source"),
  }).pair;
  const newRp = (seed: string, sourceRef: string) => {
    const manifest = changedRpManifest(digest(seed).slice(0, 40));
    return currentPair({
      ...manifest,
      sourceRef: reference(sourceRef),
      rpRegistration: {
        ...manifest.rpRegistration,
        registrationRef: reference(`${seed}-ref`),
        registrationDigest: reference(`${seed}-digest`),
        receiptRef: reference(`${seed}-receipt`),
        issuerSourceRef: reference(`${seed}-issuer`),
      },
    }).pair;
  };
  const v3 = newRp("auth103-v3-new-rp", "auth103-v3-source-ref");
  const v4 = newRp("auth103-v4-new-rp", "auth103-v4-source-ref");
  const v5 = newRp("auth103-v5-new-rp", "auth103-v5-source-ref");
  const sameRpV6 = currentPair({
    ...changedRpManifest(digest("auth103-v6-source").slice(0, 40)),
    sourceRef: reference(digest("auth103-v6-source-ref")),
    rpRegistration: v5.manifest.rpRegistration,
  }).pair;
  const newRpV6 = newRp("auth103-v6-new-rp", "auth103-v6-new-rp-source-ref");
  const predicate = (pair: typeof historical) =>
    boundCurrentPredicate(
      [
        pair.manifest.registrationRef,
        pair.manifest.recipeDigest,
        pair.manifest.clockSourceDigest,
        pair.manifest.clockPolicyRef,
      ],
      JSON.stringify(shapes.auth103Catalog),
    );
  return { historical, v1, v2, v3, v4, v5, sameRpV6, newRpV6, predicate, newRp };
}

test("a sealed fifth runtime permits only the exact sixth-runtime append", () => {
  const scratch = mkdtempSync(join(tmpdir(), "auth103-sixth-runtime-"));
  const registered = readFinancial0104CanonicalMigrationSource(REPOSITORY, scratch);
  const database = new Database(":memory:");
  try {
    const shapes = compileRoot0105ImportShapes(
      registered.auth103,
      registered.artifact,
      registered.artifact105,
      "ordinary",
    );
    const { historical, v1, v2, v3, v4, v5, sameRpV6, newRpV6, predicate, newRp } =
      sixthRuntimeLineage(shapes);
    const base = {
      historical,
      migrationNames: registered.artifact105.names,
      postShape: shapes.postShape,
    };
    // The sealed v5 registration exactly as the v5 tool compiled it.
    const fifthCompiled = compileAuth103CurrentRuntimePairSql({
      ...base,
      current: v5,
      earliestPredecessor: v1,
      oldestPredecessor: v2,
      earlierPredecessor: v3,
      predecessor: v4,
      currentSourcePredicate: predicate(v5),
    });
    expect(fifthCompiled.rpAdded).toBe(true);
    const sixthCommon = {
      ...base,
      initialPredecessor: v1,
      earliestPredecessor: v2,
      oldestPredecessor: v3,
      earlierPredecessor: v4,
      predecessor: v5,
    };
    const sameRpCompiled = compileAuth103CurrentRuntimePairSql({
      ...sixthCommon,
      current: sameRpV6,
      currentSourcePredicate: predicate(sameRpV6),
    });
    // One more sealed predecessor guard, and no RP-absence guards without an RP successor.
    expect(sameRpCompiled.guardCount).toBe(fifthCompiled.guardCount + 1 - 2);
    expect(sameRpCompiled.rpAdded).toBe(false);
    expect(pairInsertTargets(sameRpCompiled.sql)).toEqual([
      "auth103_native_deployments",
      "auth103_native_deployment_receipts",
    ]);
    const newRpCompiled = compileAuth103CurrentRuntimePairSql({
      ...sixthCommon,
      current: newRpV6,
      currentSourcePredicate: predicate(newRpV6),
    });
    expect(newRpCompiled.guardCount).toBe(fifthCompiled.guardCount + 1);
    expect(newRpCompiled.postGuardCount).toBe(fifthCompiled.postGuardCount + 1);
    expect(newRpCompiled.rpAdded).toBe(true);
    expect(pairInsertTargets(newRpCompiled.sql)).toEqual([
      "auth103_native_rp_registrations",
      "auth103_native_rp_registration_receipts",
      "auth103_native_deployments",
      "auth103_native_deployment_receipts",
    ]);
    for (const compiled of [sameRpCompiled, newRpCompiled])
      expect(
        frameHostMigrationSql(compiled.sql).every(
          (statement) => Buffer.byteLength(statement, "utf8") < 100_000,
        ),
      ).toBe(true);

    // Missing or forged sealed predecessors are refused.
    const refused = (overrides: Record<string, unknown>) =>
      expect(() =>
        compileAuth103CurrentRuntimePairSql({
          ...sixthCommon,
          current: newRpV6,
          currentSourcePredicate: predicate(newRpV6),
          ...overrides,
        } as Parameters<typeof compileAuth103CurrentRuntimePairSql>[0]),
      ).toThrow();
    refused({ earliestPredecessor: undefined });
    refused({ oldestPredecessor: undefined });
    refused({ earlierPredecessor: undefined });
    refused({ predecessor: undefined });
    refused({ predecessor: v4 });
    refused({ predecessor: v1 });
    refused({ initialPredecessor: v2 });
    refused({ initialPredecessor: historical });
    refused({ earliestPredecessor: v1 });
    refused({
      predecessor: currentPair({
        ...changedRpManifest(digest("auth103-v5-foreign").slice(0, 40)),
        sourceRef: reference(digest("auth103-v5-foreign-source-ref")),
        rpRegistration: v4.manifest.rpRegistration,
      }).pair,
    });
    refused({ current: v5, currentSourcePredicate: predicate(v5) });
    refused({ current: v4, currentSourcePredicate: predicate(v4) });
    expect(() =>
      compileAuth103CurrentRuntimePairSql({
        ...base,
        current: newRpV6,
        initialPredecessor: v1,
        currentSourcePredicate: predicate(newRpV6),
      }),
    ).toThrow();

    // Physical D1 inventory: historical + v1..v5 are 5 RP and 6 deployment originals.
    database.exec(AUTH103_NATIVE_INSTALL_DDL);
    for (const statement of frameHostMigrationSql(
      compileAuth103NativeSourceInstallContribution(
        historical.manifest,
        historical.bundleDigest,
        historical.sourceProfile,
      ),
    ))
      database.query(statement).all();
    const inserts = (sql: string) =>
      frameHostMigrationSql(sql).filter((statement) =>
        /^\s*INSERT\s+INTO\s+auth103_native_/i.test(statement),
      );
    const lineage = [
      compileAuth103CurrentRuntimePairSql({
        ...base,
        current: v1,
        currentSourcePredicate: predicate(v1),
      }),
      compileAuth103CurrentRuntimePairSql({
        ...base,
        current: v2,
        predecessor: v1,
        currentSourcePredicate: predicate(v2),
      }),
      compileAuth103CurrentRuntimePairSql({
        ...base,
        current: v3,
        predecessor: v2,
        earlierPredecessor: v1,
        currentSourcePredicate: predicate(v3),
      }),
      compileAuth103CurrentRuntimePairSql({
        ...base,
        current: v4,
        predecessor: v3,
        earlierPredecessor: v2,
        oldestPredecessor: v1,
        currentSourcePredicate: predicate(v4),
      }),
      fifthCompiled,
    ];
    for (const compiled of lineage)
      for (const statement of inserts(compiled.sql)) database.query(statement).all();
    const tables = [
      "auth103_native_rp_registrations",
      "auth103_native_rp_registration_receipts",
      "auth103_native_deployments",
      "auth103_native_deployment_receipts",
    ];
    const count = (table: string) =>
      (database.query(`SELECT count(*) AS amount FROM ${table}`).get() as { amount: number })
        .amount;
    const rows = () =>
      tables.map((table) =>
        database.query(`SELECT record_json FROM ${table} ORDER BY record_json`).all(),
      );
    expect(tables.map(count)).toEqual([5, 5, 6, 6]);
    const priorRows = rows();
    const frames = frameHostMigrationSql(newRpCompiled.sql);
    const preGuards = frames.slice(0, newRpCompiled.guardCount);
    const holds = (guard: string) => {
      try {
        return (database.query(guard).get() as { current?: number } | null)?.current === 1;
      } catch {
        return false;
      }
    };
    // Historical + five sealed predecessors + inventory + four absence guards hold here; the
    // ledger, schema-shape and source-catalog guards need the full 0105 database.
    expect(preGuards.filter(holds).length).toBeGreaterThanOrEqual(11);
    // A forged v5 with a well-formed lineage compiles, but its sealed-predecessor guard
    // cannot hold against the physical originals, so the transaction aborts before writing.
    const forgedCompiled = compileAuth103CurrentRuntimePairSql({
      ...sixthCommon,
      predecessor: newRp("auth103-v5-forged-rp", "auth103-v5-forged-source-ref"),
      current: newRpV6,
      currentSourcePredicate: predicate(newRpV6),
    });
    const forgedPreGuards = frameHostMigrationSql(forgedCompiled.sql).slice(
      0,
      forgedCompiled.guardCount,
    );
    expect(forgedPreGuards).toHaveLength(preGuards.length);
    const failing = forgedPreGuards.filter(
      (guard, index) => holds(preGuards[index] ?? "") && !holds(guard),
    );
    expect(failing).toHaveLength(1);
    const inventoryGuard = preGuards.find(
      (statement) =>
        statement.includes("count(*) FROM auth103_native_rp_registrations)=5") &&
        statement.includes("count(*) FROM auth103_native_deployments)=6"),
    );
    if (!inventoryGuard) throw new Error("sixth-runtime inventory guard missing");
    const sixthInserts = inserts(newRpCompiled.sql);
    expect(sixthInserts).toHaveLength(4);
    const sixthFirstInsert = sixthInserts[0];
    if (!sixthFirstInsert) throw new Error("sixth-runtime first insert missing");
    database.exec("BEGIN");
    database.query(sixthFirstInsert).all();
    expect(() => database.query(inventoryGuard).get()).toThrow();
    database.exec("ROLLBACK");
    const foreign = currentPair({
      ...changedRpManifest(digest("auth103-v6-foreign").slice(0, 40)),
      sourceRef: reference(digest("auth103-v6-foreign-source-ref")),
      rpRegistration: v5.manifest.rpRegistration,
    }).pair;
    database.exec("BEGIN");
    for (const statement of inserts(
      compileAuth103NativeSourceInstallContribution(
        foreign.manifest,
        foreign.bundleDigest,
        foreign.sourceProfile,
      ),
    ).slice(2))
      database.query(statement).all();
    expect(() => database.query(inventoryGuard).get()).toThrow();
    database.exec("ROLLBACK");
    expect(tables.map(count)).toEqual([5, 5, 6, 6]);
    expect(rows()).toEqual(priorRows);
    database.exec("BEGIN");
    for (const statement of sixthInserts) database.query(statement).all();
    expect(tables.map(count)).toEqual([6, 6, 7, 7]);
    // Postimage, historical, five sealed predecessors and the 6/6 + 7/7 inventory.
    const postGuards = frames.slice(newRpCompiled.guardCount + 8, newRpCompiled.guardCount + 16);
    expect(postGuards).toHaveLength(8);
    expect(postGuards.every(holds)).toBe(true);
    expect(postGuards[7]).toContain("count(*) FROM auth103_native_rp_registrations)=6");
    expect(postGuards[7]).toContain("count(*) FROM auth103_native_deployments)=7");
    database.exec("ROLLBACK");
    database.exec("BEGIN");
    for (const statement of inserts(sameRpCompiled.sql)) database.query(statement).all();
    expect(tables.map(count)).toEqual([5, 5, 7, 7]);
    database.exec("ROLLBACK");
    expect(tables.map(count)).toEqual([5, 5, 6, 6]);
    expect(rows()).toEqual(priorRows);
  } finally {
    database.close();
    registered.dispose();
    rmSync(scratch, { recursive: true, force: true });
  }
});

// Fixed source pins preserve historical served R27/R30 bytes and the R31
// candidate. The ordinary candidate changes exactly two Auth source paths.
type AuthSourceSnapshot = Readonly<Record<string, Readonly<{ blob: string; digest: string }>>>;
const R27_AUTH_SOURCES: AuthSourceSnapshot = {
  "src/auth103-native-origin-source.ts": {
    blob: "7f9513734789e7519639eb4be963523dd5d817fd",
    digest: "sha256:76bf7bedfa6f5b8f3a2689852b5b8451e2a52cba6dfd28147f7cdedd185fd543",
  },
  "src/auth103-native-source-contract.ts": {
    blob: "bed0cb92241a3c79dbbb23da59448d364737705a",
    digest: "sha256:f41092f228d77ed9888a0c410b84ce3ee2058b24f23901c46fcc995803c81ddc",
  },
  "src/shared-auth-oidc-client.ts": {
    blob: "c4c3868261ee32c35fabb08c84e4b4cc3fbad0a9",
    digest: "sha256:7df25824597c16d66fec37c75e54ca59e5a8d31df98e8c3b74587d94345f0fb8",
  },
  "src/shared-auth-session.ts": {
    blob: "2564ee7967268be3daf695b6ba85fc74636d542e",
    digest: "sha256:0c9e63f596e0dea60ec61f877b319cf08ae15d39df1d75d62103241a0b52b445",
  },
  "src/worker-request-shared-principal-issuance.ts": {
    blob: "53ab59d941a400d7114fb0e826f7a6ac2cdddf65",
    digest: "sha256:044d1ffd180826da62928ababa0710e4640808e2f4d51b8204e63978249bc625",
  },
};
const V5_AUTH_SOURCES: AuthSourceSnapshot = {
  ...R27_AUTH_SOURCES,
  "src/worker-request-shared-principal-issuance.ts": {
    blob: "75a1e3dfafdf40ffd50623d8f07bf91326bee8f6",
    digest: "sha256:988a4bfc4f5c58ef56ba9784480236cefe283392952736ffb6577a483dbf91dc",
  },
};
const R30_AUTH_SOURCES: AuthSourceSnapshot = {
  ...R27_AUTH_SOURCES,
  "src/shared-auth-session.ts": {
    blob: "d5b3b703de2038df40a74faf4491fe2bff9f2146",
    digest: "sha256:cd7cc832eaa4e4299460716d3417e814ab1043187478fa44714302a4d452d8c8",
  },
};
const R31_AUTH_SOURCES: AuthSourceSnapshot = {
  ...R30_AUTH_SOURCES,
  "src/auth103-native-origin-source.ts": {
    blob: "62560c0c70c77f9e2f53f36c9535307d5203fce7",
    digest: "sha256:7562e600a10046067f2b36a9a2d20c0bbb5a31fcaa40ad25386516242498bba2",
  },
  "src/auth103-native-source-contract.ts": {
    blob: "54bec08ecaa3ba04ab92576d36e6177d2e9902e1",
    digest: "sha256:adc4881fd1523e1ced983fcff3dd137cdc08db27fccdeee47c71320a18e907eb",
  },
  "src/shared-auth-oidc-client.ts": {
    blob: "80c692077869c7959376badcb5a00d2a7d11de57",
    digest: "sha256:24f2aacca326b0bec5c41fac8e0a23148032c462cc815f75111fc49eca7b696a",
  },
};
const ORDINARY_AUTH_SOURCES: AuthSourceSnapshot = {
  ...R31_AUTH_SOURCES,
  "src/auth103-native-origin-source.ts": {
    blob: "437a86ba4c1f7e7546ede33bf387cee164ed9f5d",
    digest: "sha256:46f773d41607834bd96be7987096ae5e5120f486b61ebd69b22242c2f6647f69",
  },
  "src/auth103-native-source-contract.ts": {
    blob: "c027681fd9c01092b6bf944c512c57819b7505c9",
    digest: "sha256:971b5dbc73237efc51cf7700615f1acc7cbf62d56970e3a4b03e440c27b2fa64",
  },
};
const REPAIRED_ORDINARY_AUTH_SOURCES: AuthSourceSnapshot = {
  ...ORDINARY_AUTH_SOURCES,
  "src/auth103-native-origin-source.ts": {
    blob: "6aa757e2b2fb49b3fa7ea2e4853fdca96a1545b4",
    digest: "sha256:9234a5660825ce5033e1ee454aa948598ba08f6f3ccfef4fdcb46cf7d5094616",
  },
};
const R27_TARGET_REF = "sha256:5a401af9c8b60ea27b81019fe8add7b75ca70a9646ffc3481880c47b2f0140ae";

function authSourcePin(sources: AuthSourceSnapshot, path: string) {
  const pin = sources[path];
  if (!pin) throw new Error(`missing Auth source pin: ${path}`);
  return pin;
}

function currentAuthSources(): AuthSourceSnapshot {
  return Object.fromEntries(
    AUTH103_CURRENT_RUNTIME_DEPLOYED_SOURCE_PATHS.map((path) => {
      const bytes = readFileSync(join(REPOSITORY, path));
      return [
        path,
        {
          blob: createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex"),
          digest: `sha256:${digest(bytes)}`,
        },
      ];
    }),
  );
}

function authSourcePathsDiff(from: AuthSourceSnapshot, to: AuthSourceSnapshot): string[] {
  return AUTH103_CURRENT_RUNTIME_DEPLOYED_SOURCE_PATHS.filter(
    (path) => authSourcePin(from, path).blob !== authSourcePin(to, path).blob,
  );
}

test("the current tool tree carries the ordinary candidate Auth paths byte-identically", () => {
  expect([...AUTH103_CURRENT_RUNTIME_DEPLOYED_SOURCE_PATHS]).toEqual([
    "src/auth103-native-origin-source.ts",
    "src/auth103-native-source-contract.ts",
    "src/shared-auth-oidc-client.ts",
    "src/shared-auth-session.ts",
    "src/worker-request-shared-principal-issuance.ts",
  ]);
  // Read actual working-tree bytes; neither HEAD nor an old Git object can stand in.
  const current = currentAuthSources();
  expect(current).toEqual(REPAIRED_ORDINARY_AUTH_SOURCES);
  expect(authSourcePathsDiff(ORDINARY_AUTH_SOURCES, current)).toEqual([
    "src/auth103-native-origin-source.ts",
  ]);
  expect(authSourcePathsDiff(R31_AUTH_SOURCES, current)).toEqual([
    "src/auth103-native-origin-source.ts",
    "src/auth103-native-source-contract.ts",
  ]);
  expect(authSourcePathsDiff(R27_AUTH_SOURCES, R30_AUTH_SOURCES)).toEqual([
    "src/shared-auth-session.ts",
  ]);
  expect(authSourcePathsDiff(V5_AUTH_SOURCES, R27_AUTH_SOURCES)).toEqual([
    "src/worker-request-shared-principal-issuance.ts",
  ]);
  // This tree cannot pass the guard for either earlier served runtime.
  expect(authSourcePathsDiff(R30_AUTH_SOURCES, current)).toEqual([
    "src/auth103-native-origin-source.ts",
    "src/auth103-native-source-contract.ts",
    "src/shared-auth-oidc-client.ts",
  ]);
  expect(authSourcePathsDiff(R27_AUTH_SOURCES, current)).toEqual([
    "src/auth103-native-origin-source.ts",
    "src/auth103-native-source-contract.ts",
    "src/shared-auth-oidc-client.ts",
    "src/shared-auth-session.ts",
  ]);
  expect(authSourcePathsDiff(V5_AUTH_SOURCES, current).length).toBeGreaterThan(0);
});

test("candidate RP successor digest derives from its exact Auth source/profile pins", () => {
  const issuerPaths = [
    "src/shared-auth-oidc-client.ts",
    "src/shared-auth-session.ts",
    "src/worker-request-shared-principal-issuance.ts",
  ];
  const dataDigest = (value: unknown) => reference(canonicalJson(value));
  const canonical = createAuth103CanonicalSourceArtifacts(REPOSITORY);
  const authSchemaFile = canonical.files[2];
  if (!authSchemaFile) throw new Error("canonical Auth103 schema file missing");
  const authSchemaRef = reference(authSchemaFile.sql);
  const configDigest = dataDigest(SHARED_AUTH_STAGING_PROFILE);
  expect(configDigest).toBe(
    "sha256:d1319cdbff67a2710844086b7d7e1dc3a343acb5354630b595a9aaedfa4aac6d",
  );
  expect(authSchemaRef).toBe(
    "sha256:6f26b9403a576c989d595c92f337368246a252e727664282f5fe6e45330ebaa6",
  );
  expect(canonical.clockPolicyRef).toBe(
    "sha256:1779ff50fb44eaf4b19a0e5b4a5a331a0ff2a5a594a6342c7e009bff03d07a8b",
  );
  const rpFor = (sourceDigest: (path: string) => string): Record<string, string> => {
    const issuerSourceRef = dataDigest([
      "takoserver.auth103.local-rp-issuer-source.v1",
      issuerPaths.map((path) => ({ path, digest: sourceDigest(path) })),
    ]);
    const registrationRef = dataDigest([
      "takoserver.auth103.local-rp-registration.v1",
      issuerSourceRef,
      configDigest,
      R27_TARGET_REF,
      authSchemaRef,
      canonical.clockPolicyRef,
    ]);
    const registrationDigest = dataDigest({
      registrationRef,
      profile: SHARED_AUTH_STAGING_PROFILE,
      issuerSourceRef,
      configDigest,
      targetRef: R27_TARGET_REF,
      authSchemaRef,
      clockPolicyRef: canonical.clockPolicyRef,
    });
    const receiptRef = dataDigest([
      "takoserver.auth103.local-rp-registration-receipt.v1",
      registrationRef,
      registrationDigest,
    ]);
    return { issuerSourceRef, registrationRef, registrationDigest, receiptRef };
  };
  const r31 = {
    issuerSourceRef: "sha256:a9800eeacb456ecff3727b1cbc23e7b33450e8690ae9c61e5ff8b8e68cfb854d",
    registrationRef: "sha256:241e2489ddc6ddbdd8fef1371cc7cd8750a4b324815ab2391dab389436e6203f",
    registrationDigest: "sha256:4f5f4d065677ed1068c40a4f7c18817eb9b5c740ca63ad74a1ccc1f36ee0c9f5",
    receiptRef: "sha256:188c461b1ce42578fd6f19844f2a83106b1b80e89cdfb1a32f065314ec148254",
  };
  expect(rpFor((path) => authSourcePin(R31_AUTH_SOURCES, path).digest)).toEqual(r31);
  expect(rpFor((path) => reference(readFileSync(join(REPOSITORY, path), "utf8")))).toEqual(r31);
});

const D1_MAX_STATEMENT_BYTES = 100_000;

test("the sixth-runtime postimage is split into per-pair reads under the D1 statement limit", () => {
  const scratch = mkdtempSync(join(tmpdir(), "auth103-sixth-postimage-"));
  const registered = readFinancial0104CanonicalMigrationSource(REPOSITORY, scratch);
  const database = new Database(":memory:");
  try {
    const shapes = compileRoot0105ImportShapes(
      registered.auth103,
      registered.artifact,
      registered.artifact105,
      "ordinary",
    );
    const { historical, v1, v2, v3, v4, v5, newRpV6, predicate } = sixthRuntimeLineage(shapes);
    const pairs = [newRpV6, historical, v1, v2, v3, v4, v5];
    const predicates = pairs.map(auth103NativePairPredicate);
    const counts = { rp: 6, deployments: 7 };
    const countPredicate = `(SELECT count(*) FROM auth103_native_rp_registrations)=6
      AND (SELECT count(*) FROM auth103_native_rp_registration_receipts)=6
      AND (SELECT count(*) FROM auth103_native_deployments)= 7
      AND (SELECT count(*) FROM auth103_native_deployment_receipts)= 7`;
    // The 566681c8 postimage ANDed every pair into ONE statement.
    const single = `SELECT CASE WHEN ${predicates.map((part) => `(${part})`).join(" AND ")}
      AND ${countPredicate} THEN 1 ELSE 0 END AS current`;
    expect(Buffer.byteLength(single, "utf8")).toBeGreaterThan(D1_MAX_STATEMENT_BYTES);
    const statements = compileAuth103CurrentRuntimePostimageStatements(predicates, counts);
    expect(statements).toHaveLength(pairs.length + 1);
    for (const statement of statements) {
      expect(Buffer.byteLength(statement, "utf8")).toBeLessThan(D1_MAX_STATEMENT_BYTES);
      expect(statement.startsWith("SELECT CASE WHEN (")).toBe(true);
      expect(statement.trimEnd().endsWith("THEN 1 ELSE 0 END AS current")).toBe(true);
    }
    expect(() =>
      compileAuth103CurrentRuntimePostimageStatements(
        [`${predicates[0]} OR ${"x".repeat(D1_MAX_STATEMENT_BYTES)}`, predicates[1] ?? ""],
        counts,
      ),
    ).toThrow();
    expect(() => compileAuth103CurrentRuntimePostimageStatements([], counts)).toThrow();
    expect(() =>
      compileAuth103CurrentRuntimePostimageStatements(predicates, { rp: 6, deployments: 0 }),
    ).toThrow();

    // Same logic as the single statement: every read is 1 only after the exact append.
    database.exec(AUTH103_NATIVE_INSTALL_DDL);
    for (const statement of frameHostMigrationSql(
      compileAuth103NativeSourceInstallContribution(
        historical.manifest,
        historical.bundleDigest,
        historical.sourceProfile,
      ),
    ))
      database.query(statement).all();
    const inserts = (sql: string) =>
      frameHostMigrationSql(sql).filter((statement) =>
        /^\s*INSERT\s+INTO\s+auth103_native_/i.test(statement),
      );
    const base = {
      historical,
      migrationNames: registered.artifact105.names,
      postShape: shapes.postShape,
    };
    for (const compiled of [
      compileAuth103CurrentRuntimePairSql({
        ...base,
        current: v1,
        currentSourcePredicate: predicate(v1),
      }),
      compileAuth103CurrentRuntimePairSql({
        ...base,
        current: v2,
        predecessor: v1,
        currentSourcePredicate: predicate(v2),
      }),
      compileAuth103CurrentRuntimePairSql({
        ...base,
        current: v3,
        predecessor: v2,
        earlierPredecessor: v1,
        currentSourcePredicate: predicate(v3),
      }),
      compileAuth103CurrentRuntimePairSql({
        ...base,
        current: v4,
        predecessor: v3,
        earlierPredecessor: v2,
        oldestPredecessor: v1,
        currentSourcePredicate: predicate(v4),
      }),
      compileAuth103CurrentRuntimePairSql({
        ...base,
        current: v5,
        predecessor: v4,
        earlierPredecessor: v3,
        oldestPredecessor: v2,
        earliestPredecessor: v1,
        currentSourcePredicate: predicate(v5),
      }),
    ])
      for (const statement of inserts(compiled.sql)) database.query(statement).all();
    const read = (): Record<string, unknown>[][] =>
      statements.map((statement) => database.query(statement).all() as Record<string, unknown>[]);
    expect(() => assertAuth103CurrentRuntimePostimageRows(read(), statements.length)).toThrow();
    expect(database.query(single).all()).toEqual([{ current: 0 }]);
    const sixth = compileAuth103CurrentRuntimePairSql({
      ...base,
      current: newRpV6,
      predecessor: v5,
      earlierPredecessor: v4,
      oldestPredecessor: v3,
      earliestPredecessor: v2,
      initialPredecessor: v1,
      currentSourcePredicate: predicate(newRpV6),
    });
    database.exec("BEGIN");
    for (const statement of inserts(sixth.sql)) database.query(statement).all();
    expect(database.query(single).all()).toEqual([{ current: 1 }]);
    const rows = read();
    expect(rows.every((result) => JSON.stringify(result) === '[{"current":1}]')).toBe(true);
    expect(() => assertAuth103CurrentRuntimePostimageRows(rows, statements.length)).not.toThrow();
    expect(() => assertAuth103CurrentRuntimePostimageRows(rows, statements.length + 1)).toThrow();
    expect(() =>
      assertAuth103CurrentRuntimePostimageRows([...rows.slice(1), []], statements.length),
    ).toThrow();
    expect(() =>
      assertAuth103CurrentRuntimePostimageRows(
        [...rows.slice(1), [{ current: 1 }, { current: 1 }]],
        statements.length,
      ),
    ).toThrow();
    expect(() =>
      assertAuth103CurrentRuntimePostimageRows(
        [...rows.slice(1), [{ current: 1, extra: 1 }]],
        statements.length,
      ),
    ).toThrow();
    // A foreign extra deployment row breaks only the count read.
    const foreign = currentPair({
      ...changedRpManifest(digest("auth103-v6-postimage-foreign").slice(0, 40)),
      sourceRef: reference(digest("auth103-v6-postimage-foreign-source-ref")),
      rpRegistration: v5.manifest.rpRegistration,
    }).pair;
    for (const statement of inserts(
      compileAuth103NativeSourceInstallContribution(
        foreign.manifest,
        foreign.bundleDigest,
        foreign.sourceProfile,
      ),
    ).slice(2))
      database.query(statement).all();
    const afterForeign = read();
    expect(afterForeign.at(-1)).toEqual([{ current: 0 }]);
    expect(() =>
      assertAuth103CurrentRuntimePostimageRows(afterForeign, statements.length),
    ).toThrow();
    database.exec("ROLLBACK");
  } finally {
    database.close();
    registered.dispose();
    rmSync(scratch, { recursive: true, force: true });
  }
});

const DISPATCH_KIND = "takoserver.auth103-current-runtime-registration-dispatch@v1";
const INSTALLED_KIND = "takoserver.auth103-current-runtime-registration-installed@v1";
const APPLY_TOOL = "566681c85c6f3b8cfc50285824383a72f742b3fe";
const FINALIZE_TOOL = "f".repeat(40);

function finalizeFixture() {
  const root = mkdtempSync(join(tmpdir(), "auth103-finalize-"));
  const bridge = join(root, "auth103-current-runtime-registration-v6");
  mkdirSync(bridge, { mode: 0o700 });
  const marker = {
    kind: DISPATCH_KIND,
    environment: "integration",
    toolCommit: FINALIZE_TOOL,
    deployedCommit: "16c196248db339c812d139ee862fcf6cfdb01192",
    versionId: "cd51f2a0-ad16-4e35-b0cc-644b3ce9ab92",
    deploymentId: "6b724d8d-9511-4e93-8c50-f3a46b77c174",
    artifactDigest: reference("artifact"),
    targetRef: reference("target"),
    sourceRef: reference("source"),
    deploymentRef: reference("deployment-ref"),
    receiptRef: reference("receipt-ref"),
    sqlDigest: reference("sql"),
    targetDigest: reference("target-json"),
    historicalReceiptDigest: reference("history"),
    publicationStatusDigest: reference("publication"),
    predecessorMarkerDigest: reference("v5-marker"),
    predecessorInstalledDigest: reference("v5-installed"),
    predecessorDeploymentRef: reference("v5-deployment"),
  };
  const dispatched = { ...marker, toolCommit: APPLY_TOOL };
  const dispatchBytes = `${JSON.stringify(dispatched, null, 2)}\n`;
  writeFileSync(join(bridge, "dispatch.json"), dispatchBytes, { mode: 0o600, flag: "wx" });
  const state = {
    pairPresent: true,
    pairAbsent: false,
    currentRpPresent: true,
    inventoryExact: true,
  };
  const calls: string[] = [];
  const input = {
    bridge,
    marker,
    state,
    verifyRemote: async () => {
      calls.push("verify");
    },
    assertUnchanged: async () => {
      calls.push("unchanged");
    },
  };
  return { root, bridge, marker, dispatched, dispatchBytes, state, input, calls };
}

test("finalize writes the installed custody once for an exact dispatched sixth registration", async () => {
  const fixture = finalizeFixture();
  try {
    const { bridge, marker, dispatched, dispatchBytes, input, calls } = fixture;
    expect(
      auth103CurrentRuntimeRegistrationState({
        pairPresent: true,
        pairAbsent: false,
        bridgeExists: true,
        custodyPairExact: false,
      }),
    ).toBe("unresolved-no-retry");
    expect(() =>
      assertAuth103CurrentRuntimeApplyAllowed({ pairAbsent: false, bridgeExists: true }),
    ).toThrow();
    expect(() =>
      assertAuth103CurrentRuntimeApplyAllowed({ pairAbsent: true, bridgeExists: true }),
    ).toThrow();
    expect(() =>
      assertAuth103CurrentRuntimeApplyAllowed({ pairAbsent: false, bridgeExists: false }),
    ).toThrow();
    expect(() =>
      assertAuth103CurrentRuntimeApplyAllowed({ pairAbsent: true, bridgeExists: false }),
    ).not.toThrow();

    const result = await finalizeAuth103CurrentRuntimeDispatchedCustody(input);
    expect(calls).toEqual(["verify", "unchanged"]);
    const markerDigest = reference(dispatchBytes);
    expect(result.markerDigest).toBe(markerDigest);
    const installedPath = join(bridge, "installed.json");
    const installedBytes = readFileSync(installedPath, "utf8");
    expect(installedBytes).toBe(
      `${JSON.stringify({ ...dispatched, kind: INSTALLED_KIND, markerDigest }, null, 2)}\n`,
    );
    expect(result.installedDigest).toBe(reference(installedBytes));
    const stat = lstatSync(installedPath);
    expect(stat.mode & 0o777).toBe(0o600);
    expect(stat.nlink).toBe(1);
    expect(readFileSync(join(bridge, "dispatch.json"), "utf8")).toBe(dispatchBytes);
    expect(assertAuth103CurrentRuntimeThirdCustodyEntries(bridge)).toBe("installed");
    const savedMarker = readSealedAuth103CustodyJson(join(bridge, "dispatch.json"), true);
    const savedInstalled = readSealedAuth103CustodyJson(installedPath, true);
    const custodyPairExact = exactAuth103CurrentRuntimeInstalledCustody(
      marker,
      savedMarker,
      savedInstalled,
    );
    expect(custodyPairExact).toBe(true);
    expect(
      auth103CurrentRuntimeRegistrationState({
        pairPresent: true,
        pairAbsent: false,
        bridgeExists: true,
        custodyPairExact,
      }),
    ).toBe("installed");
    // Exactly once: a second finalize refuses and leaves both files unchanged.
    await expect(finalizeAuth103CurrentRuntimeDispatchedCustody(input)).rejects.toThrow();
    expect(readFileSync(installedPath, "utf8")).toBe(installedBytes);
    expect(readFileSync(join(bridge, "dispatch.json"), "utf8")).toBe(dispatchBytes);
    // Apply still refuses the now-installed slot.
    expect(() =>
      assertAuth103CurrentRuntimeApplyAllowed({ pairAbsent: false, bridgeExists: true }),
    ).toThrow();
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("finalize refuses every failing precondition without writing custody", async () => {
  type Mutate = (fixture: ReturnType<typeof finalizeFixture>) => Record<string, unknown>;
  const cases: [string, Mutate][] = [
    ["pair absent", (f) => ({ state: { ...f.state, pairPresent: false, pairAbsent: true } })],
    ["pair partial", (f) => ({ state: { ...f.state, pairPresent: false } })],
    ["foreign RP", (f) => ({ state: { ...f.state, currentRpPresent: false } })],
    ["counts differ", (f) => ({ state: { ...f.state, inventoryExact: false } })],
    ["marker differs", (f) => ({ marker: { ...f.marker, sqlDigest: reference("other-sql") } })],
    ["marker version", (f) => ({ marker: { ...f.marker, versionId: "other-version" } })],
    ["marker extra key", (f) => ({ marker: { ...f.marker, extra: "foreign" } })],
    ["marker kind", (f) => ({ marker: { ...f.marker, kind: INSTALLED_KIND } })],
    [
      "remote read fails",
      () => ({
        verifyRemote: async () => {
          throw new Error("postimage read is not exact");
        },
      }),
    ],
    [
      "live or custody changed",
      () => ({
        assertUnchanged: async () => {
          throw new Error("live Version changed");
        },
      }),
    ],
    [
      "dispatch replaced during finalize",
      (f) => ({
        verifyRemote: async () => {
          rmSync(join(f.bridge, "dispatch.json"));
          writeFileSync(join(f.bridge, "dispatch.json"), f.dispatchBytes, {
            mode: 0o600,
            flag: "wx",
          });
        },
      }),
    ],
  ];
  for (const [name, mutate] of cases) {
    const fixture = finalizeFixture();
    try {
      await expect(
        finalizeAuth103CurrentRuntimeDispatchedCustody({ ...fixture.input, ...mutate(fixture) }),
        name,
      ).rejects.toThrow();
      expect(readdirSync(fixture.bridge).sort(), name).toEqual(["dispatch.json"]);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  }

  const layouts: [string, (fixture: ReturnType<typeof finalizeFixture>) => void][] = [
    ["no slot", (f) => rmSync(f.bridge, { recursive: true })],
    [
      "installed already present",
      (f) => writeFileSync(join(f.bridge, "installed.json"), "{}\n", { mode: 0o600 }),
    ],
    ["foreign entry", (f) => writeFileSync(join(f.bridge, "note.txt"), "x", { mode: 0o600 })],
    ["dispatch missing", (f) => rmSync(join(f.bridge, "dispatch.json"))],
    ["dispatch not sealed", (f) => chmodSync(join(f.bridge, "dispatch.json"), 0o644)],
    ["slot not private", (f) => chmodSync(f.bridge, 0o755)],
    [
      "dispatch hard-linked",
      (f) => linkSync(join(f.bridge, "dispatch.json"), join(f.root, "dispatch-link.json")),
    ],
    [
      "dispatch tool commit malformed",
      (f) => {
        rmSync(join(f.bridge, "dispatch.json"));
        writeFileSync(
          join(f.bridge, "dispatch.json"),
          `${JSON.stringify({ ...f.dispatched, toolCommit: "not-a-commit" }, null, 2)}\n`,
          { mode: 0o600, flag: "wx" },
        );
      },
    ],
    [
      "dispatch encoding differs",
      (f) => {
        rmSync(join(f.bridge, "dispatch.json"));
        writeFileSync(join(f.bridge, "dispatch.json"), `${JSON.stringify(f.dispatched)}\n`, {
          mode: 0o600,
          flag: "wx",
        });
      },
    ],
  ];
  for (const [name, layout] of layouts) {
    const fixture = finalizeFixture();
    try {
      layout(fixture);
      await expect(
        finalizeAuth103CurrentRuntimeDispatchedCustody(fixture.input),
        name,
      ).rejects.toThrow();
      expect(fixture.calls, name).toEqual([]);
      if (name !== "no slot" && name !== "installed already present")
        expect(readdirSync(fixture.bridge), name).not.toContain("installed.json");
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  }
});

function seventhRuntimeLineage(shapes: ReturnType<typeof compileRoot0105ImportShapes>) {
  const sixth = sixthRuntimeLineage(shapes);
  const { v5, newRpV6: v6, newRp } = sixth;
  const sameRp = (seed: string, rpRegistration: typeof v6.manifest.rpRegistration) =>
    currentPair({
      ...changedRpManifest(digest(seed).slice(0, 40)),
      sourceRef: reference(digest(`${seed}-source-ref`)),
      rpRegistration,
    }).pair;
  const v7 = sameRp("auth103-v7-same-rp", v6.manifest.rpRegistration);
  return {
    ...sixth,
    v6,
    v7,
    v7NewRp: newRp("auth103-v7-new-rp", "auth103-v7-new-rp-source-ref"),
    v7RpOfV5: sameRp("auth103-v7-rp-of-v5", v5.manifest.rpRegistration),
    v7PartialRp: sameRp("auth103-v7-partial-rp", {
      ...v6.manifest.rpRegistration,
      registrationDigest: reference("auth103-v7-partial-rp-digest"),
    }),
  };
}

function ackFor(
  current: ReturnType<typeof currentPair>["pair"],
  guardCount: number,
  postGuardCount: number,
  rpRows: boolean,
): string {
  const result = (row: Record<string, unknown>) => ({ success: true, results: [row] });
  const guard = () => result({ current: 1 });
  const changed = () => result({ changed_rows: 1 });
  return JSON.stringify([
    ...Array.from({ length: guardCount }, guard),
    ...(rpRows
      ? [
          result({
            registration_ref: current.record.rp.registrationRef,
            registration_digest: current.record.rp.registrationDigest,
            record_json: current.record.rpJson,
          }),
          changed(),
          result({
            receipt_ref: current.record.rp.receiptRef,
            registration_ref: current.record.rp.registrationRef,
            record_json: current.record.rpJson,
          }),
          changed(),
        ]
      : []),
    result({
      deployment_ref: current.record.deploymentRef,
      target_ref: current.manifest.targetRef,
      source_ref: current.manifest.sourceRef,
      artifact_digest: current.bundleDigest,
      record_json: current.record.deploymentJson,
    }),
    changed(),
    result({
      receipt_ref: current.record.deploymentReceiptRef,
      deployment_ref: current.record.deploymentRef,
      record_json: current.record.deploymentJson,
    }),
    changed(),
    ...Array.from({ length: postGuardCount }, guard),
  ]);
}

test("a sealed sixth runtime permits only the exact same-RP seventh append", () => {
  const scratch = mkdtempSync(join(tmpdir(), "auth103-seventh-runtime-"));
  const registered = readFinancial0104CanonicalMigrationSource(REPOSITORY, scratch);
  const database = new Database(":memory:");
  try {
    const shapes = compileRoot0105ImportShapes(
      registered.auth103,
      registered.artifact,
      registered.artifact105,
      "ordinary",
    );
    const { historical, v1, v2, v3, v4, v5, v6, v7, v7NewRp, v7RpOfV5, v7PartialRp, predicate } =
      seventhRuntimeLineage(shapes);
    const base = {
      historical,
      migrationNames: registered.artifact105.names,
      postShape: shapes.postShape,
    };
    // The sealed v6 registration exactly as the v6 tool compiled it (new RP).
    const sixthCompiled = compileAuth103CurrentRuntimePairSql({
      ...base,
      current: v6,
      initialPredecessor: v1,
      earliestPredecessor: v2,
      oldestPredecessor: v3,
      earlierPredecessor: v4,
      predecessor: v5,
      currentSourcePredicate: predicate(v6),
    });
    expect(sixthCompiled.rpAdded).toBe(true);
    const seventhCommon = {
      ...base,
      originPredecessor: v1,
      initialPredecessor: v2,
      earliestPredecessor: v3,
      oldestPredecessor: v4,
      earlierPredecessor: v5,
      predecessor: v6,
    };
    const seventhCompiled = compileAuth103CurrentRuntimePairSql({
      ...seventhCommon,
      current: v7,
      currentSourcePredicate: predicate(v7),
    });
    expect(seventhCompiled.rpAdded).toBe(false);
    expect(pairInsertTargets(seventhCompiled.sql)).toEqual([
      "auth103_native_deployments",
      "auth103_native_deployment_receipts",
    ]);
    // One more sealed predecessor guard, and no RP-absence guards for a same-RP append.
    expect(seventhCompiled.guardCount).toBe(sixthCompiled.guardCount + 1 - 2);
    expect(seventhCompiled.postGuardCount).toBe(sixthCompiled.postGuardCount + 1);
    expect(
      frameHostMigrationSql(seventhCompiled.sql).every(
        (statement) => Buffer.byteLength(statement, "utf8") < 100_000,
      ),
    ).toBe(true);
    const seventhFrames = frameHostMigrationSql(seventhCompiled.sql);
    expect(seventhFrames).toHaveLength(
      seventhCompiled.guardCount + 4 + seventhCompiled.postGuardCount,
    );
    expect(seventhFrames[seventhCompiled.guardCount + 1]).toContain("changes()=1");
    expect(seventhFrames[seventhCompiled.guardCount + 3]).toContain("changes()=1");

    // Lineage refusals.
    const refused = (overrides: Record<string, unknown>) =>
      expect(() =>
        compileAuth103CurrentRuntimePairSql({
          ...seventhCommon,
          current: v7,
          currentSourcePredicate: predicate(v7),
          ...overrides,
        } as Parameters<typeof compileAuth103CurrentRuntimePairSql>[0]),
      ).toThrow();
    refused({ current: v7NewRp, currentSourcePredicate: predicate(v7NewRp) });
    refused({ current: v7RpOfV5, currentSourcePredicate: predicate(v7RpOfV5) });
    refused({ current: v7PartialRp, currentSourcePredicate: predicate(v7PartialRp) });
    for (const rpRegistration of [
      historical.manifest.rpRegistration,
      v2.manifest.rpRegistration,
      v3.manifest.rpRegistration,
      v4.manifest.rpRegistration,
    ]) {
      const earlierRp = currentPair({
        ...changedRpManifest(digest(`auth103-v7-${rpRegistration.registrationRef}`).slice(0, 40)),
        sourceRef: reference(`auth103-v7-${rpRegistration.registrationRef}-source-ref`),
        rpRegistration,
      }).pair;
      refused({ current: earlierRp, currentSourcePredicate: predicate(earlierRp) });
    }
    const duplicateSource = currentPair({
      ...changedRpManifest(digest("auth103-v7-duplicate-source").slice(0, 40)),
      sourceRef: v6.manifest.sourceRef,
      rpRegistration: v6.manifest.rpRegistration,
    }).pair;
    refused({ current: duplicateSource, currentSourcePredicate: predicate(duplicateSource) });
    refused({ current: v6, currentSourcePredicate: predicate(v6) });
    const foreignTarget = currentPair({
      ...changedRpManifest(digest("auth103-v7-foreign-target").slice(0, 40)),
      sourceRef: reference("auth103-v7-foreign-target-source-ref"),
      targetRef: reference("auth103-v7-foreign-target"),
      rpRegistration: v6.manifest.rpRegistration,
    }).pair;
    refused({ current: foreignTarget, currentSourcePredicate: predicate(foreignTarget) });
    refused({ initialPredecessor: undefined });
    refused({ predecessor: undefined });
    refused({ originPredecessor: v2 });
    refused({ predecessor: v5, earlierPredecessor: v6 });
    expect(() =>
      compileAuth103CurrentRuntimePairSql({
        ...base,
        current: v7,
        originPredecessor: v1,
        currentSourcePredicate: predicate(v7),
      }),
    ).toThrow();

    // V7-10: the RP decision and the ACK both compare against v6, the newest predecessor.
    const sameRpAck = ackFor(v7, seventhCompiled.guardCount, seventhCompiled.postGuardCount, false);
    expect(() =>
      assertAuth103CurrentRuntimePairAck(
        sameRpAck,
        seventhCompiled.guardCount,
        v7,
        seventhCompiled.postGuardCount,
        v6,
      ),
    ).not.toThrow();
    expect(() =>
      assertAuth103CurrentRuntimePairAck(
        sameRpAck,
        seventhCompiled.guardCount,
        v7,
        seventhCompiled.postGuardCount,
        v5,
      ),
    ).toThrow();
    expect(() =>
      assertAuth103CurrentRuntimePairAck(
        ackFor(v7, seventhCompiled.guardCount, seventhCompiled.postGuardCount, true),
        seventhCompiled.guardCount,
        v7,
        seventhCompiled.postGuardCount,
        v6,
      ),
    ).toThrow();

    // Physical D1: historical + v1..v6 are 6 RP and 7 deployment originals.
    database.exec(AUTH103_NATIVE_INSTALL_DDL);
    for (const statement of frameHostMigrationSql(
      compileAuth103NativeSourceInstallContribution(
        historical.manifest,
        historical.bundleDigest,
        historical.sourceProfile,
      ),
    ))
      database.query(statement).all();
    const inserts = (sql: string) =>
      frameHostMigrationSql(sql).filter((statement) =>
        /^\s*INSERT\s+INTO\s+auth103_native_/i.test(statement),
      );
    for (const compiled of [
      compileAuth103CurrentRuntimePairSql({
        ...base,
        current: v1,
        currentSourcePredicate: predicate(v1),
      }),
      compileAuth103CurrentRuntimePairSql({
        ...base,
        current: v2,
        predecessor: v1,
        currentSourcePredicate: predicate(v2),
      }),
      compileAuth103CurrentRuntimePairSql({
        ...base,
        current: v3,
        predecessor: v2,
        earlierPredecessor: v1,
        currentSourcePredicate: predicate(v3),
      }),
      compileAuth103CurrentRuntimePairSql({
        ...base,
        current: v4,
        predecessor: v3,
        earlierPredecessor: v2,
        oldestPredecessor: v1,
        currentSourcePredicate: predicate(v4),
      }),
      compileAuth103CurrentRuntimePairSql({
        ...base,
        current: v5,
        predecessor: v4,
        earlierPredecessor: v3,
        oldestPredecessor: v2,
        earliestPredecessor: v1,
        currentSourcePredicate: predicate(v5),
      }),
      sixthCompiled,
    ])
      for (const statement of inserts(compiled.sql)) database.query(statement).all();
    const tables = [
      "auth103_native_rp_registrations",
      "auth103_native_rp_registration_receipts",
      "auth103_native_deployments",
      "auth103_native_deployment_receipts",
    ];
    const count = (table: string) =>
      (database.query(`SELECT count(*) AS amount FROM ${table}`).get() as { amount: number })
        .amount;
    expect(tables.map(count)).toEqual([6, 6, 7, 7]);
    const holds = (guard: string) => {
      try {
        return (database.query(guard).get() as { current?: number } | null)?.current === 1;
      } catch {
        return false;
      }
    };
    const preGuards = seventhFrames.slice(0, seventhCompiled.guardCount);
    // Historical + six sealed predecessors + inventory + two deployment absence guards.
    expect(preGuards.filter(holds).length).toBeGreaterThanOrEqual(10);
    const inventoryGuard = preGuards.find(
      (statement) =>
        statement.includes("count(*) FROM auth103_native_rp_registrations)=6") &&
        statement.includes("count(*) FROM auth103_native_deployments)=7"),
    );
    if (!inventoryGuard) throw new Error("seventh-runtime inventory guard missing");
    expect(holds(inventoryGuard)).toBe(true);
    const seventhInserts = inserts(seventhCompiled.sql);
    expect(seventhInserts).toHaveLength(2);
    database.exec("BEGIN");
    for (const statement of seventhInserts) database.query(statement).all();
    expect(tables.map(count)).toEqual([6, 6, 8, 8]);
    const postGuards = seventhFrames.slice(
      seventhCompiled.guardCount + 4,
      seventhCompiled.guardCount + 4 + 9,
    );
    expect(postGuards).toHaveLength(9);
    expect(postGuards.every(holds)).toBe(true);
    expect(postGuards[8]).toContain("count(*) FROM auth103_native_rp_registrations)=6");
    expect(postGuards[8]).toContain("count(*) FROM auth103_native_deployments)=8");
    // V7-6: the split postimage covers all eight pairs plus the inventory.
    const statements = compileAuth103CurrentRuntimePostimageStatements(
      [v7, historical, v1, v2, v3, v4, v5, v6].map(auth103NativePairPredicate),
      { rp: 6, deployments: 8 },
    );
    expect(statements).toHaveLength(9);
    for (const statement of statements)
      expect(Buffer.byteLength(statement, "utf8")).toBeLessThan(100_000);
    expect(() =>
      assertAuth103CurrentRuntimePostimageRows(
        statements.map((statement) => database.query(statement).all() as Record<string, unknown>[]),
        statements.length,
      ),
    ).not.toThrow();
    database.exec("ROLLBACK");
    expect(tables.map(count)).toEqual([6, 6, 7, 7]);
  } finally {
    database.close();
    registered.dispose();
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("successor slot selection keeps a live v6 and routes a new Version to v7", () => {
  const scratch = mkdtempSync(join(tmpdir(), "auth103-seventh-selection-"));
  const registered = readFinancial0104CanonicalMigrationSource(REPOSITORY, scratch);
  try {
    const shapes = compileRoot0105ImportShapes(
      registered.auth103,
      registered.artifact,
      registered.artifact105,
      "ordinary",
    );
    const { historical, v1, v2, v3, v4, v5, v6, v7 } = seventhRuntimeLineage(shapes);
    const sealedOf = (pairs: readonly (typeof v1)[]) =>
      pairs.map((pair, index) => ({
        versionId: `version-${index + 1}`,
        deploymentId: `deployment-${index + 1}`,
        deployedCommit: pair.manifest.sourceCommit,
        pair,
      }));
    const sealed6 = sealedOf([v1, v2, v3, v4, v5, v6]);
    const liveOf = (pair: typeof v1, versionId: string, deploymentId: string) => ({
      live: { versionId, deploymentId, commit: pair.manifest.sourceCommit },
      pair,
    });
    const keepV6 = selectAuth103CurrentRuntimeSuccessorSlot({
      ...liveOf(v6, "version-6", "deployment-6"),
      sealed: sealed6,
    });
    expect(keepV6.slot).toBe(6);
    expect(keepV6.predecessors).toEqual([v1, v2, v3, v4, v5]);
    const toV7 = selectAuth103CurrentRuntimeSuccessorSlot({
      ...liveOf(v7, "version-7", "deployment-7"),
      sealed: sealed6,
    });
    expect(toV7.slot).toBe(7);
    expect(toV7.predecessors).toEqual([v1, v2, v3, v4, v5, v6]);
    // V7-10: every "new RP?" decision, latest RP read and the ACK use v6, never v5.
    expect(auth103CurrentRuntimeRpReference(toV7.predecessors, historical)).toBe(v6);
    expect(auth103CurrentRuntimeRpReference(keepV6.predecessors, historical)).toBe(v5);
    expect(auth103CurrentRuntimeRpReference([], historical)).toBe(historical);
    // Unchanged v5/v6 behaviour with five sealed runtimes.
    const sealed5 = sealedOf([v1, v2, v3, v4, v5]);
    expect(
      selectAuth103CurrentRuntimeSuccessorSlot({
        ...liveOf(v5, "version-5", "deployment-5"),
        sealed: sealed5,
      }),
    ).toEqual({ slot: 5, predecessors: [v1, v2, v3, v4] });
    expect(
      selectAuth103CurrentRuntimeSuccessorSlot({
        ...liveOf(v6, "version-6", "deployment-6"),
        sealed: sealed5,
      }),
    ).toEqual({ slot: 6, predecessors: [v1, v2, v3, v4, v5] });
    // Any identity collision with v1..v6 is refused.
    for (const [index, sealedPair] of sealed6.entries()) {
      expect(() =>
        selectAuth103CurrentRuntimeSuccessorSlot({
          ...liveOf(v7, sealedPair.versionId, "deployment-7"),
          sealed: sealed6,
        }),
      ).toThrow();
      expect(() =>
        selectAuth103CurrentRuntimeSuccessorSlot({
          live: {
            versionId: "version-7",
            deploymentId: "deployment-7",
            commit: sealedPair.deployedCommit,
          },
          pair: v7,
          sealed: sealed6,
        }),
      ).toThrow();
      expect(() =>
        selectAuth103CurrentRuntimeSuccessorSlot({
          ...liveOf(sealedPair.pair, "version-7", "deployment-7"),
          sealed: sealed6,
        }),
      ).toThrow();
      expect(index).toBeLessThan(6);
    }
    expect(() =>
      selectAuth103CurrentRuntimeSuccessorSlot({
        ...liveOf(v6, "version-6", "deployment-other"),
        sealed: sealed6,
      }),
    ).toThrow();
    expect(() =>
      selectAuth103CurrentRuntimeSuccessorSlot({
        ...liveOf(v7, "version-7", "deployment-7"),
        sealed: [],
      }),
    ).toThrow();
    // A live v7 equal to its sealed custody stays on the v7 slot.
    expect(
      selectAuth103CurrentRuntimeSuccessorSlot({
        ...liveOf(v7, "version-7", "deployment-7"),
        sealed: sealedOf([v1, v2, v3, v4, v5, v6, v7]),
      }),
    ).toEqual({ slot: 7, predecessors: [v1, v2, v3, v4, v5, v6] });
  } finally {
    registered.dispose();
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("the runner takes every RP decision, latest RP read and ACK from the newest predecessor", () => {
  const source = readFileSync(
    join(REPOSITORY, "scripts/deploy/schema-auth103-current-runtime-registration.ts"),
    "utf8",
  );
  const runner = source.slice(
    source.indexOf("export async function runD1SchemaAuth103CurrentRuntimeRegistration("),
  );
  expect(runner.length).toBeGreaterThan(0);
  expect(runner).not.toContain("predecessorPair ?? historicalPair");
  expect(runner).toContain("const rpReferencePair = auth103CurrentRuntimeRpReference(");
  expect(runner).toMatch(/const rpAdded = currentRpSuccessor\(pair, rpReferencePair\);/u);
  expect(runner).toMatch(/readRpRows\(rpReferencePair\.record\.rp\)/u);
  expect(runner).toMatch(
    /assertAuth103CurrentRuntimePairAck\(\s*acknowledged,\s*compiled\.guardCount,\s*pair,\s*compiled\.postGuardCount,\s*rpReferencePair,\s*\)/u,
  );
  expect(runner).toContain('"auth103-current-runtime-registration-v7"');
  expect(runner).toContain('"auth103-current-runtime-registration-v8"');
});

test("finalize and status treat a dispatch-only seventh slot like the sixth", async () => {
  const fixture = finalizeFixture();
  try {
    const seventh = join(fixture.root, "auth103-current-runtime-registration-v7");
    mkdirSync(seventh, { mode: 0o700 });
    writeFileSync(join(seventh, "dispatch.json"), fixture.dispatchBytes, {
      mode: 0o600,
      flag: "wx",
    });
    const result = await finalizeAuth103CurrentRuntimeDispatchedCustody({
      ...fixture.input,
      bridge: seventh,
    });
    expect(fixture.calls).toEqual(["verify", "unchanged"]);
    const savedMarker = readSealedAuth103CustodyJson(join(seventh, "dispatch.json"), true);
    const savedInstalled = readSealedAuth103CustodyJson(join(seventh, "installed.json"), true);
    expect(result.installedDigest).toBe(savedInstalled.digest);
    expect(savedMarker.value.toolCommit).toBe(APPLY_TOOL);
    expect(
      auth103CurrentRuntimeRegistrationState({
        pairPresent: true,
        pairAbsent: false,
        bridgeExists: true,
        custodyPairExact: exactAuth103CurrentRuntimeInstalledCustody(
          fixture.marker,
          savedMarker,
          savedInstalled,
        ),
      }),
    ).toBe("installed");
    expect(() =>
      assertAuth103CurrentRuntimeApplyAllowed({ pairAbsent: true, bridgeExists: true }),
    ).toThrow();
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

function eighthRuntimeLineage(shapes: ReturnType<typeof compileRoot0105ImportShapes>) {
  const seventh = seventhRuntimeLineage(shapes);
  const { v6, v7, newRp } = seventh;
  const withRp = (seed: string, rpRegistration: typeof v7.manifest.rpRegistration) =>
    currentPair({
      ...changedRpManifest(digest(seed).slice(0, 40)),
      sourceRef: reference(digest(`${seed}-source-ref`)),
      rpRegistration,
    }).pair;
  return {
    ...seventh,
    v8: newRp("auth103-v8-new-rp", "auth103-v8-new-rp-source-ref"),
    v8SameRp: withRp("auth103-v8-same-rp", v7.manifest.rpRegistration),
    v8RpOfV6: withRp("auth103-v8-rp-of-v6", v6.manifest.rpRegistration),
    v8PartialRp: withRp("auth103-v8-partial-rp", {
      ...v7.manifest.rpRegistration,
      registrationRef: reference("auth103-v8-partial-rp-ref"),
      registrationDigest: reference("auth103-v8-partial-rp-digest"),
    }),
  };
}

test("a sealed same-RP seventh runtime permits only the exact RP-successor eighth append", () => {
  const scratch = mkdtempSync(join(tmpdir(), "auth103-eighth-runtime-"));
  const registered = readFinancial0104CanonicalMigrationSource(REPOSITORY, scratch);
  const database = new Database(":memory:");
  try {
    const shapes = compileRoot0105ImportShapes(
      registered.auth103,
      registered.artifact,
      registered.artifact105,
      "ordinary",
    );
    const lineage = eighthRuntimeLineage(shapes);
    const { historical, v1, v2, v3, v4, v5, v6, v7, v8, v8SameRp, v8RpOfV6, v8PartialRp } = lineage;
    const { predicate } = lineage;
    const base = {
      historical,
      migrationNames: registered.artifact105.names,
      postShape: shapes.postShape,
    };
    // The sealed v7 registration exactly as the v7 tool compiled it (same RP as v6).
    const seventhCompiled = compileAuth103CurrentRuntimePairSql({
      ...base,
      current: v7,
      originPredecessor: v1,
      initialPredecessor: v2,
      earliestPredecessor: v3,
      oldestPredecessor: v4,
      earlierPredecessor: v5,
      predecessor: v6,
      currentSourcePredicate: predicate(v7),
    });
    expect(seventhCompiled.rpAdded).toBe(false);
    const eighthCommon = {
      ...base,
      genesisPredecessor: v1,
      originPredecessor: v2,
      initialPredecessor: v3,
      earliestPredecessor: v4,
      oldestPredecessor: v5,
      earlierPredecessor: v6,
      predecessor: v7,
    };
    const eighthCompiled = compileAuth103CurrentRuntimePairSql({
      ...eighthCommon,
      current: v8,
      currentSourcePredicate: predicate(v8),
    });
    expect(eighthCompiled.rpAdded).toBe(true);
    expect(pairInsertTargets(eighthCompiled.sql)).toEqual([
      "auth103_native_rp_registrations",
      "auth103_native_rp_registration_receipts",
      "auth103_native_deployments",
      "auth103_native_deployment_receipts",
    ]);
    // One more sealed predecessor guard plus the two RP-absence guards.
    expect(eighthCompiled.guardCount).toBe(seventhCompiled.guardCount + 1 + 2);
    expect(eighthCompiled.postGuardCount).toBe(seventhCompiled.postGuardCount + 1);
    const eighthFrames = frameHostMigrationSql(eighthCompiled.sql);
    expect(eighthFrames).toHaveLength(
      eighthCompiled.guardCount + 8 + eighthCompiled.postGuardCount,
    );
    expect(eighthFrames.every((statement) => Buffer.byteLength(statement, "utf8") < 100_000)).toBe(
      true,
    );

    // Lineage refusals: the eighth runtime must be a new RP distinct from every sealed RP.
    const refused = (overrides: Record<string, unknown>) =>
      expect(() =>
        compileAuth103CurrentRuntimePairSql({
          ...eighthCommon,
          current: v8,
          currentSourcePredicate: predicate(v8),
          ...overrides,
        } as Parameters<typeof compileAuth103CurrentRuntimePairSql>[0]),
      ).toThrow(/lineage is not exact|collides|requires its sealed latest predecessor/u);
    refused({ current: v8SameRp, currentSourcePredicate: predicate(v8SameRp) });
    refused({ current: v8RpOfV6, currentSourcePredicate: predicate(v8RpOfV6) });
    refused({ current: v8PartialRp, currentSourcePredicate: predicate(v8PartialRp) });
    for (const earlier of [historical, v1, v2, v3, v4, v5]) {
      const reused = currentPair({
        ...changedRpManifest(
          digest(`auth103-v8-${earlier.record.rp.registrationRef}`).slice(0, 40),
        ),
        sourceRef: reference(`auth103-v8-${earlier.record.rp.registrationRef}-source-ref`),
        rpRegistration: earlier.manifest.rpRegistration,
      }).pair;
      refused({ current: reused, currentSourcePredicate: predicate(reused) });
    }
    refused({ current: v7, currentSourcePredicate: predicate(v7) });
    const duplicateSource = currentPair({
      ...changedRpManifest(digest("auth103-v8-duplicate-source").slice(0, 40)),
      sourceRef: v7.manifest.sourceRef,
      rpRegistration: v8.manifest.rpRegistration,
    }).pair;
    refused({ current: duplicateSource, currentSourcePredicate: predicate(duplicateSource) });
    const foreignTarget = currentPair({
      ...v8.manifest,
      sourceCommit: digest("auth103-v8-foreign-target").slice(0, 40),
      sourceRef: reference("auth103-v8-foreign-target-source-ref"),
      targetRef: reference("auth103-v8-foreign-target"),
    }).pair;
    refused({ current: foreignTarget, currentSourcePredicate: predicate(foreignTarget) });
    refused({ originPredecessor: undefined });
    refused({ predecessor: undefined });
    refused({ genesisPredecessor: v2 });
    // v6 and v7 share one RP, so their order is fixed by sealed custody (each marker names
    // its predecessor), not by the RP chain; any order that breaks the chain is refused.
    refused({ oldestPredecessor: v7, predecessor: v5 });
    // A v7 that did not keep v6's RP is not the sealed seventh runtime.
    refused({ predecessor: lineage.v7NewRp });

    // Every "is the RP new?" decision and the ACK compare against v7: a 4-insert ACK.
    expect(() =>
      assertAuth103CurrentRuntimePairAck(
        ackFor(v8, eighthCompiled.guardCount, eighthCompiled.postGuardCount, true),
        eighthCompiled.guardCount,
        v8,
        eighthCompiled.postGuardCount,
        v7,
      ),
    ).not.toThrow();
    expect(() =>
      assertAuth103CurrentRuntimePairAck(
        ackFor(v8, eighthCompiled.guardCount, eighthCompiled.postGuardCount, false),
        eighthCompiled.guardCount,
        v8,
        eighthCompiled.postGuardCount,
        v7,
      ),
    ).toThrow();

    // Physical D1: historical + v1..v7 are 6 RP and 8 deployment originals.
    database.exec(AUTH103_NATIVE_INSTALL_DDL);
    for (const statement of frameHostMigrationSql(
      compileAuth103NativeSourceInstallContribution(
        historical.manifest,
        historical.bundleDigest,
        historical.sourceProfile,
      ),
    ))
      database.query(statement).all();
    const inserts = (sql: string) =>
      frameHostMigrationSql(sql).filter((statement) =>
        /^\s*INSERT\s+INTO\s+auth103_native_/i.test(statement),
      );
    for (const compiled of [
      compileAuth103CurrentRuntimePairSql({
        ...base,
        current: v1,
        currentSourcePredicate: predicate(v1),
      }),
      compileAuth103CurrentRuntimePairSql({
        ...base,
        current: v2,
        predecessor: v1,
        currentSourcePredicate: predicate(v2),
      }),
      compileAuth103CurrentRuntimePairSql({
        ...base,
        current: v3,
        predecessor: v2,
        earlierPredecessor: v1,
        currentSourcePredicate: predicate(v3),
      }),
      compileAuth103CurrentRuntimePairSql({
        ...base,
        current: v4,
        predecessor: v3,
        earlierPredecessor: v2,
        oldestPredecessor: v1,
        currentSourcePredicate: predicate(v4),
      }),
      compileAuth103CurrentRuntimePairSql({
        ...base,
        current: v5,
        predecessor: v4,
        earlierPredecessor: v3,
        oldestPredecessor: v2,
        earliestPredecessor: v1,
        currentSourcePredicate: predicate(v5),
      }),
      compileAuth103CurrentRuntimePairSql({
        ...base,
        current: v6,
        predecessor: v5,
        earlierPredecessor: v4,
        oldestPredecessor: v3,
        earliestPredecessor: v2,
        initialPredecessor: v1,
        currentSourcePredicate: predicate(v6),
      }),
      seventhCompiled,
    ])
      for (const statement of inserts(compiled.sql)) database.query(statement).all();
    const tables = [
      "auth103_native_rp_registrations",
      "auth103_native_rp_registration_receipts",
      "auth103_native_deployments",
      "auth103_native_deployment_receipts",
    ];
    const count = (table: string) =>
      (database.query(`SELECT count(*) AS amount FROM ${table}`).get() as { amount: number })
        .amount;
    expect(tables.map(count)).toEqual([6, 6, 8, 8]);
    const holds = (guard: string) => {
      try {
        return (database.query(guard).get() as { current?: number } | null)?.current === 1;
      } catch {
        return false;
      }
    };
    const preGuards = eighthFrames.slice(0, eighthCompiled.guardCount);
    // Historical + seven sealed predecessors + inventory + four absence guards.
    expect(preGuards.filter(holds).length).toBeGreaterThanOrEqual(13);
    const inventoryGuard = preGuards.find(
      (statement) =>
        statement.includes("count(*) FROM auth103_native_rp_registrations)=6") &&
        statement.includes("count(*) FROM auth103_native_deployments)=8"),
    );
    if (!inventoryGuard) throw new Error("eighth-runtime inventory guard missing");
    expect(holds(inventoryGuard)).toBe(true);
    const eighthInserts = inserts(eighthCompiled.sql);
    expect(eighthInserts).toHaveLength(4);
    database.exec("BEGIN");
    for (const statement of eighthInserts) database.query(statement).all();
    expect(tables.map(count)).toEqual([7, 7, 9, 9]);
    const postGuards = eighthFrames.slice(
      eighthCompiled.guardCount + 8,
      eighthCompiled.guardCount + 8 + 10,
    );
    expect(postGuards).toHaveLength(10);
    expect(postGuards.every(holds)).toBe(true);
    expect(postGuards[9]).toContain("count(*) FROM auth103_native_rp_registrations)=7");
    expect(postGuards[9]).toContain("count(*) FROM auth103_native_deployments)=9");
    // The split postimage covers all nine pairs plus the inventory.
    const statements = compileAuth103CurrentRuntimePostimageStatements(
      [v8, historical, v1, v2, v3, v4, v5, v6, v7].map(auth103NativePairPredicate),
      { rp: 7, deployments: 9 },
    );
    expect(statements).toHaveLength(10);
    for (const statement of statements)
      expect(Buffer.byteLength(statement, "utf8")).toBeLessThan(100_000);
    expect(() =>
      assertAuth103CurrentRuntimePostimageRows(
        statements.map((statement) => database.query(statement).all() as Record<string, unknown>[]),
        statements.length,
      ),
    ).not.toThrow();
    database.exec("ROLLBACK");
    expect(tables.map(count)).toEqual([6, 6, 8, 8]);
  } finally {
    database.close();
    registered.dispose();
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("successor slot selection keeps a live v7 and routes a new Version to v8", () => {
  const scratch = mkdtempSync(join(tmpdir(), "auth103-eighth-selection-"));
  const registered = readFinancial0104CanonicalMigrationSource(REPOSITORY, scratch);
  try {
    const shapes = compileRoot0105ImportShapes(
      registered.auth103,
      registered.artifact,
      registered.artifact105,
      "ordinary",
    );
    const { historical, v1, v2, v3, v4, v5, v6, v7, v8 } = eighthRuntimeLineage(shapes);
    const sealed7 = [v1, v2, v3, v4, v5, v6, v7].map((pair, index) => ({
      versionId: `version-${index + 1}`,
      deploymentId: `deployment-${index + 1}`,
      deployedCommit: pair.manifest.sourceCommit,
      pair,
    }));
    const keepV7 = selectAuth103CurrentRuntimeSuccessorSlot({
      live: {
        versionId: "version-7",
        deploymentId: "deployment-7",
        commit: v7.manifest.sourceCommit,
      },
      pair: v7,
      sealed: sealed7,
    });
    expect(keepV7).toEqual({ slot: 7, predecessors: [v1, v2, v3, v4, v5, v6] });
    const toV8 = selectAuth103CurrentRuntimeSuccessorSlot({
      live: {
        versionId: "version-8",
        deploymentId: "deployment-8",
        commit: v8.manifest.sourceCommit,
      },
      pair: v8,
      sealed: sealed7,
    });
    expect(toV8).toEqual({ slot: 8, predecessors: [v1, v2, v3, v4, v5, v6, v7] });
    // Every RP decision for v8 uses v7 (never v6): the runner's rpReferencePair.
    expect(auth103CurrentRuntimeRpReference(toV8.predecessors, historical)).toBe(v7);
    expect(auth103CurrentRuntimeRpReference(toV8.predecessors, historical)).not.toBe(v6);
    for (const sealedPair of sealed7) {
      expect(() =>
        selectAuth103CurrentRuntimeSuccessorSlot({
          live: {
            versionId: sealedPair.versionId,
            deploymentId: "deployment-8",
            commit: v8.manifest.sourceCommit,
          },
          pair: v8,
          sealed: sealed7,
        }),
      ).toThrow(/collides/u);
      expect(() =>
        selectAuth103CurrentRuntimeSuccessorSlot({
          live: {
            versionId: "version-8",
            deploymentId: "deployment-8",
            commit: sealedPair.deployedCommit,
          },
          pair: v8,
          sealed: sealed7,
        }),
      ).toThrow(/collides/u);
      expect(() =>
        selectAuth103CurrentRuntimeSuccessorSlot({
          live: {
            versionId: "version-8",
            deploymentId: "deployment-8",
            commit: digest("auth103-v8-other-commit").slice(0, 40),
          },
          pair: sealedPair.pair,
          sealed: sealed7,
        }),
      ).toThrow(/collides/u);
    }
    expect(() =>
      selectAuth103CurrentRuntimeSuccessorSlot({
        live: { versionId: "version-9", deploymentId: "deployment-9", commit: "9".repeat(40) },
        pair: v8,
        sealed: [
          ...sealed7,
          {
            versionId: "version-8",
            deploymentId: "deployment-8",
            deployedCommit: v8.manifest.sourceCommit,
            pair: v8,
          },
        ],
      }),
    ).toThrow(/unsupported/u);
  } finally {
    registered.dispose();
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("finalize and status treat a dispatch-only eighth slot like the seventh", async () => {
  const fixture = finalizeFixture();
  try {
    const eighth = join(fixture.root, "auth103-current-runtime-registration-v8");
    mkdirSync(eighth, { mode: 0o700 });
    writeFileSync(join(eighth, "dispatch.json"), fixture.dispatchBytes, {
      mode: 0o600,
      flag: "wx",
    });
    await finalizeAuth103CurrentRuntimeDispatchedCustody({ ...fixture.input, bridge: eighth });
    const savedMarker = readSealedAuth103CustodyJson(join(eighth, "dispatch.json"), true);
    const savedInstalled = readSealedAuth103CustodyJson(join(eighth, "installed.json"), true);
    expect(
      exactAuth103CurrentRuntimeInstalledCustody(fixture.marker, savedMarker, savedInstalled),
    ).toBe(true);
    await expect(
      finalizeAuth103CurrentRuntimeDispatchedCustody({ ...fixture.input, bridge: eighth }),
    ).rejects.toThrow();
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
