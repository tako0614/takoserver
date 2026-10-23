import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createAuth103CanonicalSourceArtifacts } from "../scripts/deploy/auth103-native-source.ts";
import { buildD1MigrationImport } from "../scripts/deploy/d1-migration-import.ts";
import { canonicalSchemaShape, readMigrationArtifact } from "../scripts/deploy/migrations.ts";
import { readCurrentAuditedMigrationSourceArtifact } from "../scripts/deploy/schema.ts";
import {
  auth103SourceSchemaReady,
  boundCurrentPredicate,
  boundedOriginalShapePredicates,
  compileAuth103NativeImportShapes,
  composeAuth103NativeImportData,
} from "../scripts/deploy/schema-auth103-native-source.ts";
import { AUTH103_NATIVE_MIGRATIONS } from "../src/auth103-native-source-contract.ts";
import { MIGRATIONS } from "../src/db-schema.ts";
import { canonicalJson } from "../src/json.ts";
import { SHARED_AUTH_STAGING_PROFILE } from "../src/shared-auth-oidc-client.ts";
import { frameHostMigrationSql } from "../src/sqlite-migration-policy.ts";

// Mechanical source/import conservation only. Synthetic install DATA never
// calls a native origin constructor, models physical-target proof or enrolls a
// credential. Actual apply obtains this contribution from the original build.
const hash = (value: string): `sha256:${string}` =>
  `sha256:${createHash("sha256").update(value).digest("hex")}`;
const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;

function fixture() {
  const root = mkdtempSync(resolve(tmpdir(), "auth103-one-import-"));
  const database = new Database(":memory:", { strict: true });
  try {
    const directory = resolve(root, "migrations");
    mkdirSync(directory);
    mkdirSync(resolve(root, "src"));
    writeFileSync(
      resolve(root, "src/auth103-source-clock.ts"),
      readFileSync(resolve(import.meta.dir, "../src/auth103-source-clock.ts")),
      { mode: 0o600 },
    );
    for (const row of MIGRATIONS.filter(({ name }) => Number(name.slice(0, 4)) <= 100))
      writeFileSync(resolve(directory, row.name), row.sql, { mode: 0o600, flag: "wx" });
    const original = createAuth103CanonicalSourceArtifacts(root);
    for (const row of original.files)
      writeFileSync(resolve(directory, row.name), row.sql, { mode: 0o600, flag: "wx" });
    const artifact = readMigrationArtifact(directory);
    const shapes = compileAuth103NativeImportShapes(artifact);
    database.query("PRAGMA foreign_keys=ON").all();
    for (const [index, file] of artifact.files.slice(0, 100).entries()) {
      const source = buildD1MigrationImport([file], { freshLedger: index === 0 });
      database.query("BEGIN IMMEDIATE").all();
      try {
        for (const statement of frameHostMigrationSql(source.sql)) database.query(statement).all();
        database.query("COMMIT").all();
      } catch {
        database.query("ROLLBACK").all();
        throw new Error("opaque original100 local fixture construction failed");
      }
    }
    const state = () => {
      const shape = canonicalSchemaShape(
        database
          .query<{ type: string; name: string; tbl_name: string; sql: string }, []>(
            "SELECT type,name,tbl_name,COALESCE(sql,'') AS sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' ORDER BY type,name",
          )
          .all(),
      );
      return {
        local: artifact.names,
        applied: database
          .query<{ name: string }, []>("SELECT name FROM d1_migrations ORDER BY id")
          .all()
          .map(({ name }) => name),
        shape,
        shapeDigest: hash(shape),
      };
    };
    const checkpoint = () =>
      hash(
        canonicalJson({
          schema: database
            .query("SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name")
            .all(),
          tables: database
            .query<{ name: string; sql: string | null }, []>(
              "SELECT name,sql FROM sqlite_schema WHERE type='table' AND name NOT GLOB 'sqlite_*' ORDER BY name",
            )
            .all()
            .map(({ name, sql }) => ({
              name,
              rows: database
                .query(
                  `SELECT ${/\bWITHOUT\s+ROWID\b/iu.test(sql ?? "") ? "*" : "rowid AS __auth103_component_rowid__,*"} FROM "${name.replaceAll('"', '""')}"`,
                )
                .all()
                .map((row) => canonicalJson(row))
                .sort(),
            })),
        }),
      );
    return {
      root,
      directory,
      database,
      artifact,
      shapes,
      original,
      state,
      checkpoint,
      close() {
        database.close();
        rmSync(root, { recursive: true, force: true });
      },
    };
  } catch {
    database.close();
    rmSync(root, { recursive: true, force: true });
    // Neither source nor raw engine query bodies are failure output.
    throw new Error("opaque Auth103 import fixture construction failed");
  }
}

function installData(f: ReturnType<typeof fixture>, badReceipt = false) {
  const rpRef = hash("source-only independent RP original"),
    rpDigest = hash("source-only RP digest");
  const rpReceipt = hash("source-only RP receipt"),
    targetRef = hash("source-only target DATA");
  const sourceRef = hash("source-only source DATA"),
    artifactDigest = hash("source-only artifact DATA");
  const rpJson = canonicalJson({
    registrationRef: rpRef,
    registrationDigest: rpDigest,
    receiptRef: rpReceipt,
    profile: SHARED_AUTH_STAGING_PROFILE,
    issuerSourceRef: hash("source-only issuer DATA"),
    configDigest: hash(canonicalJson(SHARED_AUTH_STAGING_PROFILE)),
    targetRef,
    authSchemaRef: f.artifact.files[102]?.digest,
    clockPolicyRef: f.original.clockPolicyRef,
  });
  const deploymentRef = hash("source-only deployment DATA"),
    receiptRef = hash("source-only deployment receipt DATA");
  const recordJson = canonicalJson({
    receiptRef,
    artifactDigest,
    rpRecordJson: rpJson,
    manifest: {
      targetRef,
      sourceRef,
      rpRegistration: { registrationRef: rpRef, registrationDigest: rpDigest },
    },
  });
  const statements = [
    `INSERT INTO auth103_native_rp_registrations VALUES (${[rpRef, rpDigest, rpJson].map(literal).join(",")}) RETURNING *`,
    `INSERT INTO auth103_native_rp_registration_receipts VALUES (${[rpReceipt, rpRef, rpJson].map(literal).join(",")}) RETURNING *`,
    `INSERT INTO auth103_native_deployments VALUES (${[deploymentRef, targetRef, sourceRef, artifactDigest, recordJson].map(literal).join(",")}) RETURNING *`,
    `INSERT INTO auth103_native_deployment_receipts(receipt_ref,deployment_ref,record_json) VALUES (${[
      receiptRef,
      deploymentRef,
      badReceipt ? canonicalJson({ wrong: true }) : recordJson,
    ]
      .map(literal)
      .join(",")}) RETURNING *`,
  ];
  return statements.join(";\n") + ";\n";
}

function compose(f: ReturnType<typeof fixture>, installSql: string, wrongRegistration = false) {
  return composeAuth103NativeImportData({
    artifact: f.artifact,
    prefixShape: f.shapes.prefixShape,
    catalogJson: JSON.stringify(f.shapes.catalog),
    registration: [
      f.original.registrationRef,
      wrongRegistration ? hash("wrong original recipe DATA") : f.original.recipeDigest,
      f.original.clockSourceDigest,
      f.original.clockPolicyRef,
    ],
    installSql,
  });
}

function count(database: Database, table: string): number {
  return database.query<{ n: number }, []>(`SELECT count(*) AS n FROM ${table}`).get()?.n ?? -1;
}

function step(database: Database, statement: string): void {
  try {
    database.query(statement).all();
  } catch {
    throw new Error("opaque Auth103 import statement failed");
  }
}

test("the audited100 view preserves every predecessor byte while the actual fixed103 source stays separate", () => {
  const f = fixture();
  try {
    const view = readCurrentAuditedMigrationSourceArtifact(f.directory);
    expect(view.files.length).toBe(100);
    expect(view.files.every((file, index) => file.digest === f.artifact.files[index]?.digest)).toBe(
      true,
    );
    expect(f.artifact.names.slice(100)).toEqual([...AUTH103_NATIVE_MIGRATIONS]);
    expect(auth103SourceSchemaReady(f.state(), f.root, "maintenance")).toBe(true);
    expect(auth103SourceSchemaReady(f.state(), f.root, "normal")).toBe(false);
    const file = f.artifact.files[102];
    if (file === undefined) throw new Error("fixed103 source missing");
    const bytes = readFileSync(file.path);
    writeFileSync(file.path, Buffer.concat([Buffer.from("-- unreviewed source change\n"), bytes]));
    expect(auth103SourceSchemaReady(f.state(), f.root, "maintenance")).toBe(false);
    writeFileSync(file.path, bytes);
    expect(auth103SourceSchemaReady(f.state(), f.root, "maintenance")).toBe(true);
  } finally {
    f.close();
  }
});

test("one original importer preserves the exact recipes and atomically installs all103 plus mandatory independent receipts", () => {
  const f = fixture();
  try {
    const imported = compose(f, installData(f));
    const original = buildD1MigrationImport(f.artifact.files.slice(100), { freshLedger: false });
    expect(imported.sql.includes(original.sql)).toBe(true);
    expect(imported.bytes).toBe(Buffer.byteLength(imported.sql));
    expect(imported.digest).toBe(hash(imported.sql));
    f.database.query("BEGIN IMMEDIATE").all();
    try {
      for (const statement of frameHostMigrationSql(imported.sql)) step(f.database, statement);
      expect(count(f.database, "d1_migrations")).toBe(103);
      expect(count(f.database, "auth103_native_rp_registrations")).toBe(1);
      expect(count(f.database, "auth103_native_rp_registration_receipts")).toBe(1);
      expect(count(f.database, "auth103_native_deployments")).toBe(1);
      expect(count(f.database, "auth103_native_deployment_receipts")).toBe(1);
      f.database.query("COMMIT").all();
    } catch {
      f.database.query("ROLLBACK").all();
      throw new Error("opaque Auth103 positive import failed");
    }
    expect(auth103SourceSchemaReady(f.state(), f.root, "normal")).toBe(true);
    expect(f.database.query("PRAGMA foreign_key_check").all().length).toBe(0);
  } finally {
    f.close();
  }
});

test("bounded original shape predicates conserve every tuple and reject omissions and extras", () => {
  const f = fixture();
  try {
    const original = JSON.parse(f.shapes.prefixShape) as {
      type: string;
      name: string;
      table: string;
      sql: string;
    }[];
    expect(original.length).toBeGreaterThan(600);
    const check = (shape: string) =>
      boundedOriginalShapePredicates(shape).map(
        (predicate) =>
          f.database.query<{ valid: number }, []>(`SELECT (${predicate}) AS valid`).get()?.valid,
      );
    const baseline = check(f.shapes.prefixShape);
    expect(baseline.length).toBeGreaterThan(1);
    expect(baseline.every((valid) => valid === 1)).toBe(true);
    const variants = [0, Math.floor(original.length / 2), original.length - 1].map((index) => {
      const rows = original.map((row) => ({ ...row }));
      const selected = rows[index];
      if (selected === undefined) throw new Error("opaque source tuple missing");
      selected.sql += " ";
      return rows;
    });
    variants.push(original.filter((_, index) => index !== Math.floor(original.length / 2)));
    variants.push([
      ...original,
      {
        type: "table",
        name: "auth103_bounded_guard_foreign",
        table: "auth103_bounded_guard_foreign",
        sql: "CREATE TABLE auth103_bounded_guard_foreign(id TEXT)",
      },
    ]);
    const before = f.checkpoint();
    for (const rows of variants) {
      expect(check(`${JSON.stringify(rows)}\n`).some((valid) => valid !== 1)).toBe(true);
      expect(f.checkpoint()).toBe(before);
      expect(count(f.database, "d1_migrations")).toBe(100);
    }
  } finally {
    f.close();
  }
});

test("catalog literal encoding roundtrips exact SQLite UTF8 and refuses token collisions", () => {
  const f = fixture();
  try {
    const catalogJson = `${JSON.stringify(f.shapes.catalog)}\u03a9`;
    const registration = [
      f.original.registrationRef,
      f.original.recipeDigest,
      f.original.clockSourceDigest,
      f.original.clockPolicyRef,
    ];
    const sql = boundCurrentPredicate(registration, catalogJson);
    const marker = "json_each(replace(";
    const start = sql.lastIndexOf(marker);
    expect(start).toBeGreaterThan(0);
    let quote = false;
    let depth = 0;
    let end = -1;
    for (let index = start + "json_each(".length; index < sql.length; index++) {
      const character = sql[index];
      if (character === "'") {
        if (quote && sql[index + 1] === "'") {
          index++;
        } else {
          quote = !quote;
        }
      } else if (!quote && character === "(") {
        depth++;
      } else if (!quote && character === ")") {
        if (depth === 0) {
          end = index;
          break;
        }
        depth--;
      }
    }
    expect(end).toBeGreaterThan(start);
    const expression = sql.slice(start + "json_each(".length, end);
    const decoded = f.database.query<{ value: string }, []>(`SELECT ${expression} AS value`).get();
    expect(Buffer.from(decoded?.value ?? "").equals(Buffer.from(catalogJson))).toBe(true);
    expect(() => boundCurrentPredicate(registration, `${catalogJson}\ue000`)).toThrow();
  } finally {
    f.close();
  }
});

test("the final mandatory receipt fails after positive103 postshape and rolls back the complete original100 state", () => {
  const f = fixture();
  try {
    const before = f.checkpoint();
    const statements = frameHostMigrationSql(compose(f, installData(f, true)).sql);
    f.database.query("BEGIN IMMEDIATE").all();
    for (const statement of statements.slice(0, -1)) step(f.database, statement);
    // The fixed migrations and required writes really completed in THIS same
    // transaction before the unique authored final receipt error is observed.
    expect(count(f.database, "d1_migrations")).toBe(103);
    expect(count(f.database, "auth103_native_source_registration")).toBe(1);
    expect(count(f.database, "auth103_native_rp_registrations")).toBe(1);
    expect(count(f.database, "auth103_native_rp_registration_receipts")).toBe(1);
    expect(count(f.database, "auth103_native_deployments")).toBe(1);
    expect(count(f.database, "auth103_native_deployment_receipts")).toBe(0);
    expect(auth103SourceSchemaReady(f.state(), f.root, "normal")).toBe(true);
    let failure: unknown;
    try {
      f.database.query(statements.at(-1) ?? "").all();
    } catch (error) {
      failure = error;
    }
    const exactGuard =
      failure instanceof Error && failure.message.includes("Auth103 deployment receipt mismatch");
    f.database.query("ROLLBACK").all();
    expect(exactGuard).toBe(true);
    expect(f.checkpoint()).toBe(before);
    expect(count(f.database, "d1_migrations")).toBe(100);
    // Recovery is only this controlled local rollback fixture, never an apply
    // retry after an uncertain provider acknowledgement.
    f.database.query("BEGIN IMMEDIATE").all();
    for (const statement of frameHostMigrationSql(compose(f, installData(f)).sql))
      step(f.database, statement);
    f.database.query("COMMIT").all();
    expect(count(f.database, "auth103_native_deployment_receipts")).toBe(1);
  } finally {
    f.close();
  }
});

test("a stale predecessor and a wrong final source original both reject without leaving partial migration or receipt state", () => {
  const f = fixture();
  try {
    f.database
      .query("CREATE TABLE auth103_component_foreign_predecessor(id TEXT PRIMARY KEY NOT NULL)")
      .all();
    const foreign = f.checkpoint();
    f.database.query("BEGIN IMMEDIATE").all();
    let firstRejected = false;
    try {
      for (const statement of frameHostMigrationSql(compose(f, installData(f)).sql))
        f.database.query(statement).all();
    } catch (error) {
      firstRejected = error instanceof Error && error.message.includes("malformed JSON");
    }
    f.database.query("ROLLBACK").all();
    expect(firstRejected).toBe(true);
    expect(f.checkpoint()).toBe(foreign);
    f.database.query("DROP TABLE auth103_component_foreign_predecessor").all();
    const before = f.checkpoint();
    const statements = frameHostMigrationSql(compose(f, installData(f), true).sql);
    f.database.query("BEGIN IMMEDIATE").all();
    for (const statement of statements.slice(0, -2)) step(f.database, statement);
    expect(count(f.database, "d1_migrations")).toBe(103);
    expect(count(f.database, "auth103_native_deployments")).toBe(1);
    expect(count(f.database, "auth103_native_deployment_receipts")).toBe(0);
    let finalRejected = false;
    try {
      f.database.query(statements.at(-2) ?? "").all();
    } catch (error) {
      finalRejected = error instanceof Error && error.message.includes("malformed JSON");
    }
    f.database.query("ROLLBACK").all();
    expect(finalRejected).toBe(true);
    expect(f.checkpoint()).toBe(before);
  } finally {
    f.close();
  }
});
