import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applicationSchemaMatches } from "../scripts/deploy/application-schema-shape.ts";
import { readAuth103CanonicalMigrationSource } from "../scripts/deploy/auth103-canonical-migration-source.ts";
import { createAuth103CanonicalSourceArtifacts } from "../scripts/deploy/auth103-native-source.ts";
import { buildD1MigrationImport } from "../scripts/deploy/d1-migration-import.ts";
import { DeployError } from "../scripts/deploy/errors.ts";
import { canonicalSchemaShape, readMigrationArtifact } from "../scripts/deploy/migrations.ts";
import {
  auth103SourceSchemaReady,
  compileAuth103MoneyPreservedImportShapes,
  compileAuth103NativeImportShapes,
  composeAuth103NativeImportData,
  readAuth103ExpectedScratchConfigBytes,
  readAuth103OriginalCustodyDirectory,
  readAuth103OriginalDispatchData,
  readAuth103OriginalRetainedInstallSql,
} from "../scripts/deploy/schema-auth103-native-source.ts";
import {
  buildMoneyPost94RootImportData,
  moneyPost94GuardDefinitions,
} from "../scripts/deploy/schema-money-unit-cutover.ts";
import type { DeployTarget } from "../scripts/deploy/target.ts";
import { workerSchemaAllowsPending } from "../scripts/deploy/worker.ts";
import { MIGRATIONS } from "../src/db-schema.ts";
import { canonicalJson } from "../src/json.ts";
import { frameHostMigrationSql } from "../src/sqlite-migration-policy.ts";

const commit = "a".repeat(40);
const targetRef = `sha256:${"b".repeat(64)}`;
const sourceRef = `sha256:${"c".repeat(64)}`;
const importDigest = `sha256:${"d".repeat(64)}`;
const bundleDigest = `sha256:${"e".repeat(64)}` as const;
const versionId = "11111111-1111-4111-8111-111111111111";
const deploymentId = "22222222-2222-4222-8222-222222222222";
const moneySource92 =
  "sha256:6f7c1016b7ffeeb7c02006cdb8e55dc7919bfc2aeaf04c090001dcf423454be2" as const;
const names = [
  "auth103-one-import.sql",
  "auth103-source-install.sql",
  "worker.js",
  "wrangler.jsonc",
] as const;

function fixture() {
  const custody = mkdtempSync(join(tmpdir(), "auth103-original-history-"));
  const currentRelease = join(custody, "current", "release");
  const releaseDirectory = join(custody, "auth103-source-abcdef", "release");
  mkdirSync(currentRelease, { recursive: true });
  mkdirSync(releaseDirectory, { recursive: true });
  for (const [index, name] of names.entries()) {
    const bytes = `opaque-${index}\n`;
    writeFileSync(join(currentRelease, name), bytes);
    writeFileSync(join(releaseDirectory, name), bytes);
  }
  const input = {
    custody,
    commit,
    targetRef,
    sourceRef,
    importDigest,
    importBytes: 9,
    bundleDigest,
    currentRelease,
  };
  const dispatch = {
    kind: "takoserver.auth103-dispatched@v1",
    commit,
    targetRef,
    sourceRef,
    importDigest,
    importBytes: 9,
    bundleDigest,
    versionId,
    deploymentId,
    releaseDirectory,
  };
  const marker = join(custody, "auth103-dispatched.json");
  writeFileSync(marker, `${JSON.stringify(dispatch)}\n`, { mode: 0o600 });
  return {
    input,
    dispatch,
    marker,
    releaseDirectory,
    close() {
      rmSync(custody, { recursive: true, force: true });
    },
  };
}

function expectFiniteOriginalFailure(read: () => unknown, message: string, privatePath: string) {
  let failure: unknown;
  try {
    read();
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(DeployError);
  if (!(failure instanceof DeployError)) return;
  expect(failure.phase).toBe("preflight");
  expect(failure.message).toBe(message);
  expect(failure.detail).toBeUndefined();
  expect(String(failure)).not.toContain(privatePath);
  expect(failure.cause).toBeUndefined();
}

test("the original dispatch DATA reader pins exact IDs and every retained release byte", () => {
  const f = fixture();
  try {
    expect(readAuth103OriginalDispatchData(f.input)).toEqual({
      versionId,
      deploymentId,
      releaseDirectory: f.releaseDirectory,
    });
    writeFileSync(join(f.releaseDirectory, "worker.js"), "different original module\n");
    expect(() => readAuth103OriginalDispatchData(f.input)).toThrow();
    writeFileSync(
      join(f.releaseDirectory, "worker.js"),
      readFileSync(join(f.input.currentRelease, "worker.js")),
    );
    expect(readAuth103OriginalDispatchData(f.input).versionId).toBe(versionId);
  } finally {
    f.close();
  }
});

test("missing, partial, foreign, or mismatched original dispatch remains unavailable", () => {
  const f = fixture();
  try {
    for (const value of [
      "{",
      JSON.stringify({ ...f.dispatch, importDigest: `sha256:${"f".repeat(64)}` }),
      JSON.stringify({ ...f.dispatch, versionId: "unbound" }),
      JSON.stringify({ ...f.dispatch, releaseDirectory: f.input.currentRelease }),
      JSON.stringify({ ...f.dispatch, extra: true }),
      `${JSON.stringify(Object.fromEntries(Object.entries(f.dispatch).reverse()))}\n`,
      `${JSON.stringify(f.dispatch, null, 2)}\n`,
    ]) {
      writeFileSync(f.marker, value);
      expect(() => readAuth103OriginalDispatchData(f.input)).toThrow();
    }
    writeFileSync(f.marker, Buffer.from([0xff]));
    expect(() => readAuth103OriginalDispatchData(f.input)).toThrow();
    rmSync(f.marker);
    expectFiniteOriginalFailure(
      () => readAuth103OriginalDispatchData(f.input),
      "Auth103 original custody file is unavailable",
      f.input.custody,
    );
  } finally {
    f.close();
  }
});

test("missing original release and private source paths return finite preflight errors", () => {
  const f = fixture();
  try {
    rmSync(f.releaseDirectory, { recursive: true });
    expectFiniteOriginalFailure(
      () => readAuth103OriginalDispatchData(f.input),
      "Auth103 original release is outside its dispatch custody",
      f.input.custody,
    );
    mkdirSync(f.releaseDirectory, { recursive: true });
    for (const [index, name] of names.entries())
      writeFileSync(join(f.releaseDirectory, name), `opaque-${index}\n`);
    rmSync(join(f.input.currentRelease, "worker.js"));
    expectFiniteOriginalFailure(
      () => readAuth103OriginalDispatchData(f.input),
      "Auth103 original release bytes differ from the source-owned build",
      f.input.custody,
    );
    expectFiniteOriginalFailure(
      () =>
        readAuth103OriginalDispatchData({
          ...f.input,
          custody: join(f.input.custody, "private-missing"),
        }),
      "Auth103 original custody file is unavailable",
      f.input.custody,
    );
  } finally {
    f.close();
  }
});

test("retained install and expected scratch config reads refuse missing private paths finitely", () => {
  const privateRoot = mkdtempSync(join(tmpdir(), "auth103-private-files-"));
  try {
    const retainedInstall = join(privateRoot, "auth103-source-install.sql");
    const expectedConfig = join(privateRoot, "expected-original-wrangler.jsonc");
    expectFiniteOriginalFailure(
      () => readAuth103OriginalRetainedInstallSql(retainedInstall),
      "Auth103 original source installation contribution is unavailable",
      privateRoot,
    );
    expectFiniteOriginalFailure(
      () => readAuth103ExpectedScratchConfigBytes(expectedConfig),
      "Auth103 original Worker config is unavailable",
      privateRoot,
    );
    writeFileSync(retainedInstall, "opaque-owned-install\n");
    writeFileSync(expectedConfig, "opaque-owned-config\n");
    expect(readAuth103OriginalRetainedInstallSql(retainedInstall)).toBe("opaque-owned-install\n");
    expect(readAuth103ExpectedScratchConfigBytes(expectedConfig).toString("utf8")).toBe(
      "opaque-owned-config\n",
    );
    rmSync(retainedInstall);
    rmSync(expectedConfig);
    expectFiniteOriginalFailure(
      () => readAuth103OriginalRetainedInstallSql(retainedInstall),
      "Auth103 original source installation contribution is unavailable",
      privateRoot,
    );
    expectFiniteOriginalFailure(
      () => readAuth103ExpectedScratchConfigBytes(expectedConfig),
      "Auth103 original Worker config is unavailable",
      privateRoot,
    );
  } finally {
    rmSync(privateRoot, { recursive: true, force: true });
  }
});

test("original custody absence, symlink, and changed directory identity stay path-free", () => {
  const privateRoot = mkdtempSync(join(tmpdir(), "auth103-private-custody-"));
  const directory = join(privateRoot, "owned");
  const alias = join(privateRoot, "alias");
  const previous = process.env.TAKOSERVER_AUTH103_INSTALL_CUSTODY_DIRECTORY;
  try {
    process.env.TAKOSERVER_AUTH103_INSTALL_CUSTODY_DIRECTORY = directory;
    expectFiniteOriginalFailure(
      () => readAuth103OriginalCustodyDirectory(),
      "Auth103 custody requires its original absolute physical directory",
      privateRoot,
    );
    mkdirSync(directory, { mode: 0o700 });
    const custody = readAuth103OriginalCustodyDirectory();
    expect(custody.path).toBe(directory);
    custody.assertUnchanged();
    symlinkSync(directory, alias);
    process.env.TAKOSERVER_AUTH103_INSTALL_CUSTODY_DIRECTORY = alias;
    expectFiniteOriginalFailure(
      () => readAuth103OriginalCustodyDirectory(),
      "Auth103 custody requires its original absolute physical directory",
      privateRoot,
    );
    rmSync(directory, { recursive: true });
    expectFiniteOriginalFailure(
      () => custody.assertUnchanged(),
      "Auth103 original custody directory changed during preparation",
      privateRoot,
    );
    mkdirSync(directory, { mode: 0o700 });
    process.env.TAKOSERVER_AUTH103_INSTALL_CUSTODY_DIRECTORY = directory;
    const replacement = readAuth103OriginalCustodyDirectory();
    renameSync(directory, join(privateRoot, "former-custody"));
    mkdirSync(directory, { mode: 0o700 });
    expectFiniteOriginalFailure(
      () => replacement.assertUnchanged(),
      "Auth103 original custody directory changed during preparation",
      privateRoot,
    );
  } finally {
    if (previous === undefined) delete process.env.TAKOSERVER_AUTH103_INSTALL_CUSTODY_DIRECTORY;
    else process.env.TAKOSERVER_AUTH103_INSTALL_CUSTODY_DIRECTORY = previous;
    rmSync(privateRoot, { recursive: true, force: true });
  }
});

test("Money-preserved source shape is a distinct exact full100 to full103 replay", () => {
  const root = mkdtempSync(join(tmpdir(), "auth103-money-union-source-"));
  try {
    mkdirSync(join(root, "migrations"));
    mkdirSync(join(root, "src"));
    writeFileSync(
      join(root, "src", "auth103-source-clock.ts"),
      readFileSync(join(import.meta.dir, "..", "src", "auth103-source-clock.ts")),
    );
    for (const row of MIGRATIONS.filter(({ name }) => Number(name.slice(0, 4)) <= 100))
      writeFileSync(join(root, "migrations", row.name), row.sql, { flag: "wx" });
    const generatedFromPhysical100 = readAuth103CanonicalMigrationSource(root);
    try {
      expect(generatedFromPhysical100.physicalNames.length).toBe(100);
      expect(generatedFromPhysical100.artifact.files.length).toBe(103);
      expect(generatedFromPhysical100.prefix.digest).toBe(
        readMigrationArtifact(join(root, "migrations")).digest,
      );
      const ordinary = compileAuth103NativeImportShapes(generatedFromPhysical100.artifact);
      expect(
        auth103SourceSchemaReady(
          {
            local: generatedFromPhysical100.physicalNames,
            applied: generatedFromPhysical100.prefix.names,
            shape: ordinary.prefixShape,
            shapeDigest: hash(ordinary.prefixShape),
          },
          root,
          "maintenance",
        ),
      ).toBe(true);
      const ordinary103 = {
        local: generatedFromPhysical100.physicalNames,
        applied: generatedFromPhysical100.artifact.names,
        shape: ordinary.postShape,
        shapeDigest: hash(ordinary.postShape),
      };
      expect(auth103SourceSchemaReady(ordinary103, root, "normal")).toBe(true);
      expect(
        workerSchemaAllowsPending(
          { environment: "integration" } as DeployTarget,
          ordinary103,
          root,
        ),
      ).toBe(true);
      generatedFromPhysical100.assertCurrent();
    } finally {
      generatedFromPhysical100.dispose();
    }
    for (const row of createAuth103CanonicalSourceArtifacts(root).files)
      writeFileSync(join(root, "migrations", row.name), row.sql, { flag: "wx" });
    const generatedFromPhysical103 = readAuth103CanonicalMigrationSource(root);
    try {
      expect(generatedFromPhysical103.physicalNames.length).toBe(103);
      generatedFromPhysical103.assertCurrent();
    } finally {
      generatedFromPhysical103.dispose();
    }
    const source = readMigrationArtifact(join(root, "migrations"));
    const shapes = compileAuth103MoneyPreservedImportShapes(source);
    expect(source.files.length).toBe(103);
    expect(shapes.prefixShape.length).toBeGreaterThan(0);
    expect(shapes.postShape.length).toBeGreaterThan(shapes.prefixShape.length);
    expect(shapes.catalog.length).toBeGreaterThan(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 30000);

const hash = (value: string): `sha256:${string}` =>
  `sha256:${createHash("sha256").update(value).digest("hex")}`;
const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;

function apply(database: Database, sql: string): void {
  for (const statement of frameHostMigrationSql(sql)) database.query(statement).all();
}

function databaseState(database: Database, applied: readonly string[]) {
  const shape = canonicalSchemaShape(
    database
      .query<{ type: string; name: string; tbl_name: string; sql: string }, []>(
        "SELECT type,name,tbl_name,COALESCE(sql,'') AS sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' ORDER BY type,name",
      )
      .all(),
  );
  return { applied, shape, shapeDigest: hash(shape) };
}

function checkpoint(database: Database): string {
  const tables = database
    .query<{ name: string; sql: string | null }, []>(
      "SELECT name,sql FROM sqlite_schema WHERE type='table' AND name NOT GLOB 'sqlite_*' ORDER BY name",
    )
    .all();
  return hash(
    canonicalJson({
      schema: database
        .query("SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name")
        .all(),
      tables: tables.map(({ name, sql }) => ({
        name,
        rows: database
          .query(
            `SELECT ${/\bWITHOUT\s+ROWID\b/iu.test(sql ?? "") ? "*" : "rowid AS __auth103_test_rowid__,*"} FROM "${name.replaceAll('"', '""')}"`,
          )
          .all()
          .map((row) => canonicalJson(row))
          .sort(),
      })),
    }),
  );
}

function syntheticInstallSql(badReceipt: boolean): string {
  const rpRef = hash("money union RP original"),
    rpDigest = hash("money union RP digest"),
    rpReceipt = hash("money union RP receipt");
  const deploymentRef = hash("money union deployment original"),
    deploymentReceipt = hash("money union deployment receipt");
  const rpJson = canonicalJson({
    registrationRef: rpRef,
    registrationDigest: rpDigest,
    receiptRef: rpReceipt,
  });
  const recordJson = canonicalJson({
    receiptRef: deploymentReceipt,
    artifactDigest: bundleDigest,
    rpRecordJson: rpJson,
    manifest: {
      targetRef,
      sourceRef,
      rpRegistration: { registrationRef: rpRef, registrationDigest: rpDigest },
    },
  });
  return (
    [
      `INSERT INTO auth103_native_rp_registrations VALUES (${[rpRef, rpDigest, rpJson].map(literal).join(",")}) RETURNING *`,
      `INSERT INTO auth103_native_rp_registration_receipts VALUES (${[rpReceipt, rpRef, rpJson].map(literal).join(",")}) RETURNING *`,
      `INSERT INTO auth103_native_deployments VALUES (${[deploymentRef, targetRef, sourceRef, bundleDigest, recordJson].map(literal).join(",")}) RETURNING *`,
      `INSERT INTO auth103_native_deployment_receipts(receipt_ref,deployment_ref,record_json) VALUES (${[
        deploymentReceipt,
        deploymentRef,
        badReceipt ? canonicalJson({ wrong: true }) : recordJson,
      ]
        .map(literal)
        .join(",")}) RETURNING *`,
    ].join(";\n") + ";\n"
  );
}

test("fixed Money98 guards survive ONE103; foreign prestate and late receipt fault leave the original100 unchanged", () => {
  const root = mkdtempSync(join(tmpdir(), "auth103-money-union-import-"));
  const database = new Database(":memory:", { strict: true });
  let candidate: ReturnType<typeof readAuth103CanonicalMigrationSource> | undefined;
  try {
    mkdirSync(join(root, "migrations"));
    mkdirSync(join(root, "src"));
    writeFileSync(
      join(root, "src", "auth103-source-clock.ts"),
      readFileSync(join(import.meta.dir, "..", "src", "auth103-source-clock.ts")),
    );
    for (const row of MIGRATIONS.filter(({ name }) => Number(name.slice(0, 4)) <= 100))
      writeFileSync(join(root, "migrations", row.name), row.sql, { flag: "wx" });
    const original = createAuth103CanonicalSourceArtifacts(root);
    candidate = readAuth103CanonicalMigrationSource(root);
    const artifact = candidate.artifact;
    const physicalNames = candidate.physicalNames;
    expect(physicalNames.length).toBe(100);
    const shapes = compileAuth103MoneyPreservedImportShapes(artifact);
    const bindings = {
      freezeBindingDigest: hash("money union freeze binding"),
      originDigest: hash("money union origin"),
      original92BackupDigest: hash("money union backup"),
      writerDigest: hash("money union writer"),
      previousWriterEpoch: hash("money union old epoch"),
      nextWriterEpoch: hash("money union new epoch"),
    };
    database.query("PRAGMA foreign_keys=ON").all();
    apply(database, buildD1MigrationImport(artifact.files.slice(0, 94), { freshLedger: true }).sql);
    for (const [, definition] of moneyPost94GuardDefinitions()) apply(database, `${definition};`);
    database
      .query(
        `INSERT INTO money_cutover_freeze VALUES (1,${[
          bindings.freezeBindingDigest,
          bindings.originDigest,
          bindings.original92BackupDigest,
          bindings.writerDigest,
          moneySource92,
        ]
          .map(literal)
          .join(",")})`,
      )
      .all();
    database
      .query(
        `INSERT INTO money_cutover_authorized_epoch VALUES (1,${literal(bindings.previousWriterEpoch)})`,
      )
      .all();
    const moneySuffix = buildMoneyPost94RootImportData({
      files: artifact.files,
      ...bindings,
    });
    apply(database, moneySuffix.beforeFinancialSql);
    apply(database, moneySuffix.afterFinancialSql);
    apply(
      database,
      buildD1MigrationImport(artifact.files.slice(98, 100), { freshLedger: false }).sql,
    );
    const names100 = artifact.names.slice(0, 100);
    expect(applicationSchemaMatches(databaseState(database, names100), shapes.prefixShape)).toBe(
      true,
    );
    const selected = {
      environment: "integration",
      schemaMaintenanceMode: "pre-auth103-quiesced",
      moneyCutoverWriterPolicy: "transaction-fenced-usd-micros-v1",
      moneyCutoverWriterEpoch: bindings.nextWriterEpoch,
      auth103NativeProfile: "root-shared-auth-staging-v1",
    } as DeployTarget;
    const pending100 = { ...databaseState(database, names100), local: physicalNames };
    expect(workerSchemaAllowsPending(selected, pending100, root)).toBe(true);
    const noProfile = { ...selected };
    delete noProfile.auth103NativeProfile;
    expect(workerSchemaAllowsPending(noProfile, pending100, root)).toBe(false);
    expect(
      auth103SourceSchemaReady(
        { ...databaseState(database, names100), local: physicalNames },
        root,
        "maintenance",
        "money-preserved",
      ),
    ).toBe(true);
    expect(
      auth103SourceSchemaReady(
        { ...databaseState(database, names100), local: physicalNames },
        root,
        "maintenance",
      ),
    ).toBe(false);
    const source = {
      kind: "takoserver.money-original-preserved100-source@v1" as const,
      qualification: "native-read-only" as const,
      accountId: "a".repeat(32),
      databaseId: versionId,
      databaseName: "synthetic-money-union",
      workerName: "synthetic-money-union",
      originDigest: bindings.originDigest,
      original92BackupDigest: bindings.original92BackupDigest,
      suffixBindingDigest: hash("money union suffix binding"),
      freezeBindingDigest: bindings.freezeBindingDigest,
      freezeWriterDigest: bindings.writerDigest,
      freezeSourceDigest: moneySource92,
      currentWriterEpoch: bindings.nextWriterEpoch,
      schemaShapeDigest: databaseState(database, names100).shapeDigest,
      normalVersionId: versionId,
      normalHostReady: false as const,
    };
    const compose = (badReceipt: boolean) =>
      composeAuth103NativeImportData({
        artifact,
        prefixShape: shapes.prefixShape,
        postShape: shapes.postShape,
        moneySource: source,
        catalogJson: JSON.stringify(shapes.catalog),
        registration: [
          original.registrationRef,
          original.recipeDigest,
          original.clockSourceDigest,
          original.clockPolicyRef,
        ],
        installSql: syntheticInstallSql(badReceipt),
      });
    const before = checkpoint(database);
    database.query("CREATE TABLE auth103_foreign_extra(id TEXT PRIMARY KEY)").all();
    expect(
      workerSchemaAllowsPending(
        selected,
        { ...databaseState(database, names100), local: physicalNames },
        root,
      ),
    ).toBe(false);
    expect(
      auth103SourceSchemaReady(
        { ...databaseState(database, names100), local: physicalNames },
        root,
        "maintenance",
        "money-preserved",
      ),
    ).toBe(false);
    database.query("BEGIN IMMEDIATE").all();
    expect(() => apply(database, compose(false).sql)).toThrow();
    database.query("ROLLBACK").all();
    database.query("DROP TABLE auth103_foreign_extra").all();
    expect(checkpoint(database)).toBe(before);
    database.query("BEGIN IMMEDIATE").all();
    expect(() => apply(database, compose(true).sql)).toThrow();
    database.query("ROLLBACK").all();
    expect(checkpoint(database)).toBe(before);
    database.query("BEGIN IMMEDIATE").all();
    apply(database, compose(false).sql);
    database.query("COMMIT").all();
    expect(
      applicationSchemaMatches(databaseState(database, artifact.names), shapes.postShape),
    ).toBe(true);
    expect(
      workerSchemaAllowsPending(
        selected,
        { ...databaseState(database, artifact.names), local: physicalNames },
        root,
      ),
    ).toBe(true);
    expect(
      auth103SourceSchemaReady(
        { ...databaseState(database, artifact.names), local: physicalNames },
        root,
        "normal",
        "money-preserved",
      ),
    ).toBe(true);
    expect(
      auth103SourceSchemaReady(
        { ...databaseState(database, artifact.names), local: physicalNames },
        root,
        "normal",
      ),
    ).toBe(false);
    expect(
      database.query("SELECT count(*) AS n FROM auth103_native_deployment_receipts").get(),
    ).toEqual({ n: 1 });
    expect(database.query("SELECT count(*) AS n FROM money_cutover_freeze").get()).toEqual({
      n: 1,
    });
    expect(database.query("SELECT count(*) AS n FROM money_cutover_writer_permit").get()).toEqual({
      n: 0,
    });
  } finally {
    database.close();
    candidate?.dispose();
    rmSync(root, { recursive: true, force: true });
  }
}, 60000);
