import { createHash } from "node:crypto";
import {
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import {
  applicationSchemaMatches,
  deriveExpectedApplicationShape,
} from "./application-schema-shape.ts";
import { CloudflareState } from "./cloudflare-state.ts";
import { RemoteD1, sqlLiteral } from "./d1.ts";
import { buildD1MigrationImport } from "./d1-migration-import.ts";
import {
  DeployError,
  type DeployPhase,
  mutationError,
  preflightError,
  verificationError,
} from "./errors.ts";
import { type D1SchemaState, readD1SchemaState, readMigrationArtifact } from "./migrations.ts";
import {
  type CommandResult,
  REPOSITORY,
  requireEnvironment,
  resolveCloudflareCredential,
  runCommand,
  wranglerCommand,
} from "./process.ts";
import {
  type DeployEnvironment,
  qualifySource,
  sealDirectory,
  unsealDirectory,
} from "./qualification.ts";
import { readAuditedMigrationArtifact, type SchemaWaveBoundary } from "./schema.ts";
import type { DeployTarget } from "./target.ts";

const SURFACE = "takoserver-d1-schema-0058-rehearsal";
const MIGRATION = "0058_cloudflare_managed_worker_domain_receipts.sql";
const PROVIDER = "takoserver.synthetic.0058.rehearsal";
const FORMAT = "takoserver.managed-worker-version-execution-material@v1";
const PROTOCOL = "takoserver.managed-worker-release@v4";
const ROLLBACK_PROBE_TIMEOUT_SECONDS = 120;
const TABLES = [
  "cloudflare_managed_worker_receipts",
  "cloudflare_managed_worker_version_execution_material",
  "cloudflare_managed_worker_version_execution_secrets",
  "cloudflare_managed_worker_version_execution_provider_proofs",
] as const;
const STATES = ["pending", "committed", "deleting", "deleted"] as const;
type Run = (
  command: readonly string[],
  options?: { readonly env?: Readonly<Record<string, string>>; readonly input?: string },
) => Promise<CommandResult>;

export interface Rehearsal0058Invocation {
  readonly action: "status" | "apply";
  readonly environment: DeployEnvironment;
  readonly commit: string;
  readonly throughMigration?: SchemaWaveBoundary;
}

export interface Rehearsal0058Options {
  readonly run?: Run;
  readonly cloudflareEnvironment?: Readonly<Record<string, string>>;
  readonly custodyPath?: string;
  readonly migrationDirectory?: string;
  readonly outputDirectory?: string;
  readonly fetcher?: (request: Request) => Promise<Response>;
}

interface IsolatedTarget {
  readonly accountId: string;
  readonly databaseId: string;
  readonly databaseName: string;
}

export interface Fixture0058Snapshot {
  readonly counts: Readonly<Record<(typeof TABLES)[number], number>>;
  readonly states: Readonly<Record<(typeof STATES)[number], number>>;
  readonly digest: `sha256:${string}`;
  readonly blobBytes: number;
  readonly exactSyntheticBlobs: boolean;
  readonly foreignKeyViolations: number;
  readonly foreignKeysEnabled: boolean;
}

type FixtureCounts = Fixture0058Snapshot["counts"];

async function read0058Counts(
  database: Pick<RemoteD1, "query">,
  phase: DeployPhase,
): Promise<FixtureCounts> {
  const pairs = await Promise.all(
    TABLES.map(async (table) => {
      const rows = await database.query(
        phase,
        `0058 ${table} count`,
        `SELECT COUNT(*) AS n FROM ${table}`,
      );
      const n = rows[0]?.n;
      if (rows.length !== 1 || !Number.isSafeInteger(n) || Number(n) < 0)
        throw preflightError("0058 affected-table count readback is malformed");
      return [table, Number(n)] as const;
    }),
  );
  return Object.fromEntries(pairs) as Record<(typeof TABLES)[number], number>;
}

function isExactFixtureSize(counts: FixtureCounts): boolean {
  return counts[TABLES[0]] === 4 && TABLES.slice(1).every((table) => counts[table] === 3);
}

async function onlySyntheticRows(
  database: Pick<RemoteD1, "query">,
  phase: DeployPhase,
): Promise<boolean> {
  const uids = STATES.map((state) => sqlLiteral(`synthetic-0058-${state}`)).join(", ");
  for (const table of TABLES) {
    const rows = await database.query(
      phase,
      `0058 ${table} fixture ownership`,
      `SELECT COUNT(*) AS n FROM ${table} WHERE provider_id != ${sqlLiteral(PROVIDER)} OR resource_uid NOT IN (${uids})`,
    );
    if (rows.length !== 1 || rows[0]?.n !== 0) return false;
  }
  return true;
}

/** Deterministic, non-secret synthetic rows only; never derives from a live customer row. */
export function build0058SyntheticFixtureSql(): string {
  const lines: string[] = [];
  const d = (letter: string) => `sha256:${letter.repeat(64)}`;
  for (const [index, state] of STATES.entries()) {
    const uid = `synthetic-0058-${state}`;
    const native = `version:synthetic-0058-${state}`;
    const operation = `publish-synthetic-0058-${state}`;
    const descriptor = {
      format: "synthetic-0058",
      publication: {
        providerId: PROVIDER,
        providerInstallationId: "synthetic-installation",
        accountId: "synthetic-account",
        dispatchNamespace: "synthetic-namespace",
        tenantRef: "synthetic-tenant",
        workerResourceUid: "synthetic-worker-uid",
        resourceUid: uid,
        nativeId: native,
        logicalWorkerId: "synthetic-worker",
        releaseOperationId: operation,
        publicationGeneration: 1,
        releaseProtocol: PROTOCOL,
        receiptDescriptorDigest: d("d"),
      },
    };
    const observed = {
      executionMaterial: { format: FORMAT, publicationGeneration: 1 },
      releaseProtocol: PROTOCOL,
      releaseProof: {
        providerInstallationId: "synthetic-installation",
        accountId: "synthetic-account",
        tenantRef: "synthetic-tenant",
        dispatchNamespace: "synthetic-namespace",
        operationId: operation,
        resourceUid: uid,
        preparationId: "synthetic-preparation",
        preparationCommitment: d("c"),
        logicalWorkerId: "synthetic-worker",
        workerResourceUid: "synthetic-worker-uid",
        secretNames: ["API_KEY"],
      },
    };
    const q = sqlLiteral;
    lines.push(
      `INSERT INTO ${TABLES[0]} (provider_id, resource_uid, native_id, kind, logical_worker_id, operation_id, generation, descriptor_digest, state, observed_json) VALUES (${q(PROVIDER)}, ${q(uid)}, ${q(native)}, 'version', 'synthetic-worker', ${q(operation)}, 1, ${q(d("d"))}, 'pending', ${q(JSON.stringify(observed))});`,
    );
    lines.push(
      `INSERT INTO ${TABLES[1]} (provider_id, resource_uid, native_id, provider_installation_id, account_id, dispatch_namespace, tenant_ref, worker_resource_uid, logical_worker_id, publication_operation_id, publication_generation, release_protocol, descriptor_digest, execution_descriptor_digest, preparation_kind, preparation_id, preparation_commitment, secret_names_json, provider_proof_names_json, descriptor_json, seal_key_id) VALUES (${q(PROVIDER)}, ${q(uid)}, ${q(native)}, 'synthetic-installation', 'synthetic-account', 'synthetic-namespace', 'synthetic-tenant', 'synthetic-worker-uid', 'synthetic-worker', ${q(operation)}, 1, ${q(PROTOCOL)}, ${q(d("d"))}, ${q(d("a"))}, 'runtime_input', 'synthetic-preparation', ${q(d("c"))}, '["API_KEY"]', '["object:MEDIA:runtime-proof"]', ${q(JSON.stringify(descriptor))}, 'synthetic-key');`,
    );
    const nonce = Buffer.alloc(12, index + 1).toString("hex");
    const ciphertext = Buffer.alloc(17 + index, index + 11).toString("hex");
    lines.push(
      `INSERT INTO ${TABLES[2]} (provider_id, resource_uid, name, nonce, ciphertext) VALUES (${q(PROVIDER)}, ${q(uid)}, 'API_KEY', X'${nonce}', X'${ciphertext}');`,
    );
    lines.push(
      `INSERT INTO ${TABLES[3]} (provider_id, resource_uid, name, nonce, ciphertext) VALUES (${q(PROVIDER)}, ${q(uid)}, 'object:MEDIA:runtime-proof', X'${nonce}', X'${ciphertext}');`,
    );
    if (state !== "pending") {
      lines.push(
        `UPDATE ${TABLES[0]} SET state = 'committed', provider_etag = 'synthetic-etag' WHERE provider_id = ${q(PROVIDER)} AND resource_uid = ${q(uid)};`,
      );
    }
    if (state === "deleting" || state === "deleted") {
      const previous = {
        resourceUid: uid,
        nativeId: native,
        kind: "version",
        logicalWorkerId: "synthetic-worker",
        operationId: operation,
        generation: 1,
        descriptorDigest: d("d"),
        state: "committed",
        providerEtag: "synthetic-etag",
        observed,
      };
      lines.push(
        `UPDATE ${TABLES[0]} SET state = 'deleting', operation_id = ${q(`delete-${uid}`)}, generation = 2, previous_json = ${q(JSON.stringify(previous))} WHERE provider_id = ${q(PROVIDER)} AND resource_uid = ${q(uid)};`,
      );
    }
    if (state === "deleted") {
      lines.push(
        `UPDATE ${TABLES[0]} SET state = 'deleted', provider_etag = NULL, previous_json = NULL, observed_json = '{"deleted":true}' WHERE provider_id = ${q(PROVIDER)} AND resource_uid = ${q(uid)};`,
      );
    }
  }
  return `${lines.join("\n")}\n`;
}

/** Value-free digest still binds every receipt column and exact sealed BLOB bytes. */
export async function read0058FixtureSnapshot(
  database: Pick<RemoteD1, "query">,
  phase: DeployPhase,
): Promise<Fixture0058Snapshot> {
  const bounded = await read0058Counts(database, phase);
  if (bounded[TABLES[0]] > 4 || TABLES.slice(1).some((table) => bounded[table] > 3))
    throw verificationError("0058 fixture readback exceeds the synthetic row bound");
  const rows = await Promise.all([
    database.query(
      phase,
      "0058 receipt rows",
      `SELECT * FROM ${TABLES[0]} ORDER BY provider_id, resource_uid`,
    ),
    database.query(
      phase,
      "0058 material rows",
      `SELECT * FROM ${TABLES[1]} ORDER BY provider_id, resource_uid`,
    ),
    database.query(
      phase,
      "0058 sealed secret rows",
      `SELECT provider_id, resource_uid, name, hex(nonce) AS nonce, hex(ciphertext) AS ciphertext FROM ${TABLES[2]} ORDER BY provider_id, resource_uid, name`,
    ),
    database.query(
      phase,
      "0058 sealed proof rows",
      `SELECT provider_id, resource_uid, name, hex(nonce) AS nonce, hex(ciphertext) AS ciphertext FROM ${TABLES[3]} ORDER BY provider_id, resource_uid, name`,
    ),
  ]);
  const counts = Object.fromEntries(
    TABLES.map((table, index) => [table, rows[index]?.length ?? -1]),
  ) as Record<(typeof TABLES)[number], number>;
  if (TABLES.some((table) => counts[table] !== bounded[table]))
    throw verificationError("0058 fixture rows changed while reading the bounded snapshot");
  const states = Object.fromEntries(
    STATES.map((state) => [state, rows[0]?.filter((row) => row.state === state).length ?? -1]),
  ) as Record<(typeof STATES)[number], number>;
  const foreignKeys = await database.query(
    phase,
    "0058 foreign key setting",
    "PRAGMA foreign_keys",
  );
  const violations = await database.query(
    phase,
    "0058 foreign key check",
    "PRAGMA foreign_key_check",
  );
  let blobBytes = 0;
  for (const group of [rows[2], rows[3]]) {
    for (const row of group ?? []) {
      if (
        typeof row.nonce !== "string" ||
        typeof row.ciphertext !== "string" ||
        !/^[0-9A-F]+$/u.test(row.nonce) ||
        !/^[0-9A-F]+$/u.test(row.ciphertext)
      ) {
        throw verificationError("0058 BLOB readback was not exact uppercase hex");
      }
      blobBytes += (row.nonce.length + row.ciphertext.length) / 2;
    }
  }
  const expectedBlobRows = (name: string) =>
    STATES.slice(0, 3)
      .map((state, index) => ({
        provider_id: PROVIDER,
        resource_uid: `synthetic-0058-${state}`,
        name,
        nonce: Buffer.alloc(12, index + 1)
          .toString("hex")
          .toUpperCase(),
        ciphertext: Buffer.alloc(17 + index, index + 11)
          .toString("hex")
          .toUpperCase(),
      }))
      .sort((left, right) => left.resource_uid.localeCompare(right.resource_uid));
  const exactSyntheticBlobs =
    JSON.stringify(rows[2]) === JSON.stringify(expectedBlobRows("API_KEY")) &&
    JSON.stringify(rows[3]) === JSON.stringify(expectedBlobRows("object:MEDIA:runtime-proof"));
  return {
    counts,
    states,
    digest: digest(JSON.stringify(rows)),
    blobBytes,
    exactSyntheticBlobs,
    foreignKeyViolations: violations.length,
    foreignKeysEnabled: foreignKeys.length === 1 && foreignKeys[0]?.foreign_keys === 1,
  };
}

function assertFixture(snapshot: Fixture0058Snapshot): void {
  if (
    snapshot.counts[TABLES[0]] !== 4 ||
    snapshot.counts[TABLES[1]] !== 3 ||
    snapshot.counts[TABLES[2]] !== 3 ||
    snapshot.counts[TABLES[3]] !== 3 ||
    STATES.some((state) => snapshot.states[state] !== 1) ||
    snapshot.blobBytes < 174 ||
    !snapshot.exactSyntheticBlobs ||
    snapshot.foreignKeyViolations !== 0 ||
    !snapshot.foreignKeysEnabled
  ) {
    throw verificationError("0058 synthetic fixture is incomplete or violates foreign keys");
  }
}

function digest(value: string | Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function exactCustody(path: string, ordinary: DeployTarget): IsolatedTarget {
  if (!isAbsolute(path)) throw preflightError("0058 isolated target path must be absolute");
  let status: ReturnType<typeof lstatSync>;
  try {
    status = lstatSync(path);
  } catch {
    throw preflightError("0058 isolated target declaration could not be read");
  }
  if (
    !status.isFile() ||
    status.isSymbolicLink() ||
    status.nlink !== 1 ||
    status.uid !== process.getuid?.() ||
    (status.mode & 0o077) !== 0
  ) {
    throw preflightError("0058 isolated target declaration must be owned 0600 regular file");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw preflightError("0058 isolated target declaration is invalid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    throw preflightError("0058 isolated target declaration is invalid");
  const input = parsed as Record<string, unknown>;
  const keys = Object.keys(input).sort();
  const expected = [
    "accountId",
    "credentialScopeReviewed",
    "databaseId",
    "databaseName",
    "disposableFixtureCustody",
    "kind",
    "writersQuiesced",
  ].sort();
  if (
    JSON.stringify(keys) !== JSON.stringify(expected) ||
    input.kind !== "takoserver.d1-0058-isolated-rehearsal-target@v1" ||
    input.accountId !== ordinary.accountId ||
    input.databaseId === ordinary.d1.databaseId ||
    typeof input.databaseId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(input.databaseId) ||
    typeof input.databaseName !== "string" ||
    !/^[a-z0-9][a-z0-9_-]{2,62}$/u.test(input.databaseName) ||
    input.databaseName === ordinary.d1.databaseName ||
    input.disposableFixtureCustody !== true ||
    input.writersQuiesced !== true ||
    input.credentialScopeReviewed !== true
  ) {
    throw preflightError(
      "0058 isolated target declaration does not name a distinct reviewed fixture-custody D1",
    );
  }
  return {
    accountId: input.accountId as string,
    databaseId: input.databaseId,
    databaseName: input.databaseName,
  };
}

function config(path: string, selected: IsolatedTarget, migrationDirectory: string): string {
  writeFileSync(
    path,
    `${JSON.stringify({ name: "takoserver-0058-synthetic-rehearsal", account_id: selected.accountId, compatibility_date: "2026-08-17", d1_databases: [{ binding: "STATE_DB", database_name: selected.databaseName, database_id: selected.databaseId, migrations_dir: migrationDirectory }] }, null, 2)}\n`,
    { flag: "wx", mode: 0o600 },
  );
  return path;
}

function assertPredecessor(
  state: D1SchemaState,
  names: readonly string[],
  files: ReturnType<typeof readAuditedMigrationArtifact>["files"],
): void {
  if (
    JSON.stringify(state.applied) !== JSON.stringify(names.slice(0, 57)) ||
    !applicationSchemaMatches(state, deriveExpectedApplicationShape(files.slice(0, 57)))
  ) {
    throw preflightError(
      "0058 rehearsal requires exact canonical 0057 predecessor and no pending prior wave",
    );
  }
}

function triggerDigest(state: D1SchemaState): string {
  const rows: unknown = JSON.parse(state.shape);
  if (!Array.isArray(rows)) throw preflightError("0058 trigger shape is malformed");
  return digest(
    JSON.stringify(
      rows.filter(
        (row) =>
          typeof row === "object" &&
          row !== null &&
          (row as { type?: unknown }).type === "trigger" &&
          String((row as { name?: unknown }).name).startsWith(
            "cloudflare_managed_worker_version_execution_",
          ),
      ),
    ),
  );
}

/** Isolated production-shaped D1 experiment only; never emits a protected-wave receipt. */
export async function runD1Schema0058Rehearsal(
  invocation: Rehearsal0058Invocation,
  ordinary: DeployTarget,
  options: Rehearsal0058Options = {},
): Promise<Record<string, unknown>> {
  if (
    invocation.environment !== "rehearsal" ||
    ordinary.environment !== "rehearsal" ||
    invocation.throughMigration !== undefined
  ) {
    throw preflightError("0058 fixture rehearsal is rehearsal-only and accepts no selector");
  }
  const selected = exactCustody(
    options.custodyPath ?? requireEnvironment("TAKOSERVER_D1_0058_ISOLATED_TARGET_PATH"),
    ordinary,
  );
  const run = options.run ?? runCommand;
  const credential = await resolveCloudflareCredential("rehearsal", {
    cloudflareEnvironment: options.cloudflareEnvironment,
    run,
  });
  if (credential?.source !== "api-token")
    throw preflightError("0058 rehearsal requires explicit API token");
  const environment = credential.childEnvironment;
  const provider = new CloudflareState({
    accountId: selected.accountId,
    token: credential.token,
    ...(options.fetcher === undefined ? {} : { fetcher: options.fetcher }),
  });
  const assertProviderIdentity = async (stage: string): Promise<void> => {
    const result = await provider.read(
      `/d1/database/${encodeURIComponent(selected.databaseId)}`,
      `0058 isolated D1 identity ${stage}`,
    );
    if (
      typeof result !== "object" ||
      result === null ||
      Array.isArray(result) ||
      (result as { uuid?: unknown }).uuid !== selected.databaseId ||
      (result as { name?: unknown }).name !== selected.databaseName
    ) {
      throw preflightError(
        "0058 isolated D1 provider identity does not match the declared UUID and name",
      );
    }
  };
  await assertProviderIdentity("before inspection");
  const source = readAuditedMigrationArtifact(
    options.migrationDirectory ?? resolve(REPOSITORY, "migrations"),
  );
  const file = source.files[57];
  if (file?.name !== MIGRATION) throw preflightError("0058 audited file is missing");
  const temporary = options.outputDirectory === undefined;
  const root =
    options.outputDirectory ?? mkdtempSync(join(tmpdir(), "takoserver-d1-0058-rehearsal-"));
  mkdirSync(root, { recursive: true, mode: 0o700 });
  let targetMayHaveChanged = false;
  try {
    const inspection = config(
      join(root, "inspect-wrangler.jsonc"),
      selected,
      options.migrationDirectory ?? resolve(REPOSITORY, "migrations"),
    );
    const initialDb = new RemoteD1(inspection, { environment, run });
    const initial = await readD1SchemaState(initialDb);
    const is0057 = JSON.stringify(initial.applied) === JSON.stringify(source.names.slice(0, 57));
    const is0058 = JSON.stringify(initial.applied) === JSON.stringify(source.names.slice(0, 58));
    if (!is0057 && !is0058)
      throw preflightError("0058 rehearsal status requires exact 0057 or 0058 lineage");
    const initialCounts = await read0058Counts(initialDb, "preflight");
    const canonicalShape = applicationSchemaMatches(
      initial,
      deriveExpectedApplicationShape(source.files.slice(0, is0057 ? 57 : 58)),
    );
    const empty = TABLES.every((table) => initialCounts[table] === 0);
    const statusSnapshot =
      empty ||
      (isExactFixtureSize(initialCounts) && (await onlySyntheticRows(initialDb, "preflight")))
        ? await read0058FixtureSnapshot(initialDb, "preflight")
        : null;
    if (invocation.action === "status")
      return {
        kind: "takoserver.d1-0058-rehearsal-status@v1",
        surface: SURFACE,
        environment: "rehearsal",
        accountId: selected.accountId,
        databaseId: selected.databaseId,
        databaseName: selected.databaseName,
        providerIdentityVerified: true,
        appliedMigration: initial.applied.at(-1),
        schemaShapeDigest: initial.shapeDigest,
        fixtureTableCounts: initialCounts,
        fixtureDigest: statusSnapshot?.digest ?? null,
        foreignKeyViolations: statusSnapshot?.foreignKeyViolations ?? null,
        canonicalShape,
        readyForApply:
          is0057 &&
          empty &&
          canonicalShape &&
          statusSnapshot?.foreignKeyViolations === 0 &&
          statusSnapshot.foreignKeysEnabled,
        qualification: "not-production-evidence",
      };
    assertPredecessor(initial, source.names, source.files);
    if (!empty)
      throw preflightError(
        "0058 fixture custody requires four exact empty affected tables and enabled clean foreign keys",
      );
    const initialSnapshot = statusSnapshot;
    if (initialSnapshot?.foreignKeyViolations !== 0 || initialSnapshot?.foreignKeysEnabled !== true)
      throw preflightError("0058 fixture custody requires enabled, clean foreign keys");
    const reviewer = requireEnvironment("TAKOSERVER_INDEPENDENT_REVIEW");
    if (!/^[A-Za-z0-9][A-Za-z0-9._@ -]{1,127}$/u.test(reviewer))
      throw preflightError("0058 independent reviewer is invalid");
    const qualified = await qualifySource({
      environment: "rehearsal",
      commit: invocation.commit,
      policy: "clean-remote",
      run,
    });
    const gate = await run(["bun", "run", "check:migrations"]);
    if (gate.exitCode !== 0)
      throw preflightError(
        "0058 scoped migration gate failed",
        `${gate.stdout}${gate.stderr}`.trim(),
      );
    const release = join(root, "release");
    const migrationRoot = join(release, "migrations");
    mkdirSync(migrationRoot, { recursive: true, mode: 0o700 });
    for (const migration of source.files.slice(0, 58))
      copyFileSync(migration.path, join(migrationRoot, migration.name));
    const sealedSource = readMigrationArtifact(migrationRoot);
    if (
      JSON.stringify(sealedSource.names) !== JSON.stringify(source.names.slice(0, 58)) ||
      sealedSource.files.some((copied, index) => copied.digest !== source.files[index]?.digest)
    )
      throw preflightError("0058 sealed migration prefix changed during qualification");
    const sealed0058 = sealedSource.files[57];
    if (sealed0058?.name !== MIGRATION)
      throw preflightError("0058 sealed migration file is missing");
    const migrationImport = buildD1MigrationImport([sealed0058], { freshLedger: false });
    const importPath = join(release, "migration-import.sql");
    writeFileSync(importPath, migrationImport.sql, { flag: "wx", mode: 0o600 });
    // Exercise the exact transport and migration/ledger prefix before the real
    // import. The last statement MUST fail on the duplicate migration name.
    // A provider that committed any preceding DDL/rows fails the readback and
    // this isolated target is quarantined; nothing is undone automatically.
    const rollbackProbeSql = `${migrationImport.sql}\nINSERT INTO "d1_migrations" (name) VALUES ('${MIGRATION}');\n`;
    const rollbackProbePath = join(release, "rollback-probe.sql");
    writeFileSync(rollbackProbePath, rollbackProbeSql, { flag: "wx", mode: 0o600 });
    // Wrangler migrations apply sends one built migration over D1 /query,
    // unlike execute --file which uses /import. Give it the audited 0058 SQL
    // plus one ledger insert; Wrangler appends the second ledger insert and
    // must roll the entire built query back on that UNIQUE failure.
    const queryProbeRoot = join(release, "query-probe-migrations");
    mkdirSync(queryProbeRoot, { recursive: true, mode: 0o700 });
    for (const migration of source.files.slice(0, 57))
      copyFileSync(migration.path, join(queryProbeRoot, migration.name));
    writeFileSync(join(queryProbeRoot, MIGRATION), migrationImport.sql, {
      flag: "wx",
      mode: 0o600,
    });
    const queryProbeConfigPath = config(
      join(release, "query-probe-wrangler.jsonc"),
      selected,
      "query-probe-migrations",
    );
    const fixtureSql = build0058SyntheticFixtureSql();
    const fixturePath = join(release, "fixture.sql");
    writeFileSync(fixturePath, fixtureSql, { flag: "wx", mode: 0o600 });
    const configPath = config(join(release, "wrangler.jsonc"), selected, "migrations");
    const sealed = sealDirectory(release, [
      "wrangler.jsonc",
      "migration-import.sql",
      "rollback-probe.sql",
      "query-probe-wrangler.jsonc",
      "fixture.sql",
      ...source.names.slice(0, 58).map((name) => `migrations/${name}`),
      ...source.names.slice(0, 58).map((name) => `query-probe-migrations/${name}`),
    ]);
    const db = new RemoteD1(configPath, { environment, run });
    const reread = await readD1SchemaState(db);
    assertPredecessor(reread, source.names, source.files);
    if (reread.shapeDigest !== initial.shapeDigest)
      throw preflightError("0058 schema changed before fixture seed");
    const beforeSeed = await read0058FixtureSnapshot(db, "preflight");
    if (beforeSeed.digest !== initialSnapshot.digest)
      throw preflightError("0058 fixture tables changed before seed");
    await assertProviderIdentity("at fixture seed fence");
    sealed.assertUnchanged();
    const fileCommand = (path: string) =>
      wranglerCommand([
        "d1",
        "execute",
        selected.databaseName,
        "--remote",
        "--yes",
        "--config",
        configPath,
        "--file",
        path,
      ]);
    const boundedProbeCommand = (command: readonly string[]) => [
      "timeout",
      "--signal=TERM",
      "--kill-after=5s",
      `${ROLLBACK_PROBE_TIMEOUT_SECONDS}s`,
      ...command,
    ];
    let timeoutReady = false;
    try {
      timeoutReady = (await run(["timeout", "--version"])).exitCode === 0;
    } catch {
      // Missing timeout must fail before this surface seeds the selected D1.
    }
    if (!timeoutReady) throw preflightError("0058 rollback probes require GNU timeout");
    let seed: CommandResult | null = null;
    targetMayHaveChanged = true;
    try {
      seed = await run(fileCommand(fixturePath), { env: environment });
    } catch {
      // A transport exception is an unknown acknowledgement, not a retry signal.
    }
    let seeded: Fixture0058Snapshot;
    let seededState: D1SchemaState;
    try {
      seededState = await readD1SchemaState(db, "verification");
      seeded = await read0058FixtureSnapshot(db, "verification");
    } catch {
      throw mutationError(
        "0058 fixture seed acknowledgement/readback indeterminate; do not replay",
      );
    }
    if (seed === null || seed.exitCode !== 0)
      throw mutationError(
        "0058 fixture seed acknowledgement indeterminate; inspect authoritative state, do not replay",
        JSON.stringify({
          appliedMigrations: seededState.applied.length,
          fixtureCounts: seeded.counts,
        }),
      );
    assertFixture(seeded);
    if (
      seededState.shapeDigest !== initial.shapeDigest ||
      JSON.stringify(seededState.applied) !== JSON.stringify(initial.applied)
    )
      throw verificationError("0058 fixture seed changed schema or lineage");
    // The fixture seed already touched D1. Every final-fence failure is a
    // verification failure, even when a reused reader labels it preflight.
    const immediate = await readD1SchemaState(db, "verification");
    if (
      JSON.stringify(immediate.applied) !== JSON.stringify(source.names.slice(0, 57)) ||
      immediate.shapeDigest !== initial.shapeDigest ||
      !applicationSchemaMatches(
        immediate,
        deriveExpectedApplicationShape(source.files.slice(0, 57)),
      )
    ) {
      throw verificationError(
        "0058 exact 0057 lineage or canonical shape changed at migration fence",
      );
    }
    const fenced = await read0058FixtureSnapshot(db, "verification");
    if (fenced.digest !== seeded.digest)
      throw verificationError("0058 fixture rows changed at migration fence");
    await assertProviderIdentity("at migration fence");
    sealed.assertUnchanged();
    let queryProbe: CommandResult | null = null;
    try {
      queryProbe = await run(
        boundedProbeCommand(
          wranglerCommand([
            "d1",
            "migrations",
            "apply",
            selected.databaseName,
            "--remote",
            "--config",
            queryProbeConfigPath,
          ]),
        ),
        { env: environment },
      );
    } catch {
      // A lost acknowledgement is not evidence of a rolled-back /query.
    }
    let queryProbeState: D1SchemaState;
    let queryProbeRows: Fixture0058Snapshot;
    try {
      queryProbeState = await readD1SchemaState(db, "verification");
      queryProbeRows = await read0058FixtureSnapshot(db, "verification");
    } catch {
      throw mutationError(
        "0058 query rollback probe readback indeterminate; quarantine isolated D1",
      );
    }
    if (
      queryProbe?.exitCode !== 1 ||
      !/UNIQUE constraint failed: (?:main\.)?d1_migrations\.name/iu.test(
        `${queryProbe.stdout}${queryProbe.stderr}`,
      ) ||
      JSON.stringify(queryProbeState.applied) !== JSON.stringify(source.names.slice(0, 57)) ||
      queryProbeState.shapeDigest !== initial.shapeDigest ||
      !applicationSchemaMatches(
        queryProbeState,
        deriveExpectedApplicationShape(source.files.slice(0, 57)),
      ) ||
      queryProbeRows.digest !== seeded.digest ||
      queryProbeRows.foreignKeyViolations !== 0 ||
      !queryProbeRows.foreignKeysEnabled
    ) {
      throw mutationError(
        "0058 query rollback probe did not prove exact 0057 restoration; quarantine isolated D1",
        JSON.stringify({
          providerExitClass:
            queryProbe === null
              ? "transport_unknown"
              : queryProbe.exitCode === 0
                ? "unexpected_success"
                : queryProbe.exitCode === 1
                  ? "expected_exit_but_unqualified"
                  : "timeout_or_unexpected_exit",
          appliedMigrationCount: queryProbeState.applied.length,
          schemaRestored: queryProbeState.shapeDigest === initial.shapeDigest,
          rowsRestored: queryProbeRows.digest === seeded.digest,
        }),
      );
    }
    await assertProviderIdentity("after query rollback probe");
    sealed.assertUnchanged();
    let rollbackProbe: CommandResult | null = null;
    try {
      rollbackProbe = await run(boundedProbeCommand(fileCommand(rollbackProbePath)), {
        env: environment,
      });
    } catch {
      // A transport exception may follow either rollback or partial commit.
    }
    let probeState: D1SchemaState;
    let probeRows: Fixture0058Snapshot;
    try {
      probeState = await readD1SchemaState(db, "verification");
      probeRows = await read0058FixtureSnapshot(db, "verification");
    } catch {
      throw mutationError("0058 rollback probe readback indeterminate; quarantine isolated D1");
    }
    if (
      rollbackProbe?.exitCode !== 1 ||
      !/UNIQUE constraint failed: (?:main\.)?d1_migrations\.name/iu.test(
        `${rollbackProbe.stdout}${rollbackProbe.stderr}`,
      ) ||
      JSON.stringify(probeState.applied) !== JSON.stringify(source.names.slice(0, 57)) ||
      probeState.shapeDigest !== initial.shapeDigest ||
      !applicationSchemaMatches(
        probeState,
        deriveExpectedApplicationShape(source.files.slice(0, 57)),
      ) ||
      probeRows.digest !== seeded.digest ||
      probeRows.foreignKeyViolations !== 0 ||
      !probeRows.foreignKeysEnabled
    ) {
      throw mutationError(
        "0058 rollback probe did not prove exact 0057 restoration; quarantine isolated D1",
        JSON.stringify({
          providerExitClass:
            rollbackProbe === null
              ? "transport_unknown"
              : rollbackProbe.exitCode === 0
                ? "unexpected_success"
                : rollbackProbe.exitCode === 1
                  ? "expected_exit_but_unqualified"
                  : "timeout_or_unexpected_exit",
          appliedMigrationCount: probeState.applied.length,
          schemaRestored: probeState.shapeDigest === initial.shapeDigest,
          rowsRestored: probeRows.digest === seeded.digest,
        }),
      );
    }
    await assertProviderIdentity("after rollback probe");
    sealed.assertUnchanged();
    const started = performance.now();
    let applied: CommandResult | null = null;
    try {
      applied = await run(fileCommand(importPath), { env: environment });
    } catch {
      // The provider may have committed before the transport failed.
    }
    const elapsedMs = Math.round(performance.now() - started);
    // Even a nonzero exit may have committed: authoritative readback is mandatory and no replay follows.
    let post: D1SchemaState;
    let after: Fixture0058Snapshot;
    try {
      post = await readD1SchemaState(db, "verification");
      after = await read0058FixtureSnapshot(db, "verification");
    } catch {
      throw mutationError("0058 import acknowledgement/readback indeterminate; do not replay");
    }
    if (applied === null || applied.exitCode !== 0)
      throw mutationError(
        "0058 import acknowledgement indeterminate; inspect authoritative lineage and fixture, do not replay",
        JSON.stringify({
          exitCode: applied?.exitCode ?? null,
          appliedMigrations: post.applied.length,
          fixtureDigestMatches: after.digest === seeded.digest,
        }),
      );
    if (
      JSON.stringify(post.applied) !== JSON.stringify(source.names.slice(0, 58)) ||
      !applicationSchemaMatches(post, deriveExpectedApplicationShape(source.files.slice(0, 58))) ||
      triggerDigest(post) !== triggerDigest(initial) ||
      after.digest !== seeded.digest ||
      after.foreignKeyViolations !== 0 ||
      !after.foreignKeysEnabled
    ) {
      throw verificationError(
        "0058 D1 post-readback differs in lineage, schema, triggers, rows, BLOBs or foreign keys",
      );
    }
    return {
      kind: "takoserver.d1-0058-isolated-qualification@v1",
      surface: SURFACE,
      environment: "rehearsal",
      accountId: selected.accountId,
      databaseId: selected.databaseId,
      databaseName: selected.databaseName,
      providerIdentityVerified: true,
      commit: qualified.commit,
      remoteRef: qualified.remoteRef,
      reviewer,
      migration: MIGRATION,
      migrationDigest: file.digest,
      importDigest: migrationImport.digest,
      importBytes: migrationImport.bytes,
      queryRollbackProbe: "failed-and-exact-0057-restored",
      queryRollbackProbeDigest: digest(migrationImport.sql),
      rollbackProbe: "failed-and-exact-0057-restored",
      rollbackProbeDigest: digest(rollbackProbeSql),
      rollbackProbeBytes: Buffer.byteLength(rollbackProbeSql),
      fixtureBytes: Buffer.byteLength(fixtureSql),
      fixtureDigest: seeded.digest,
      fixtureCounts: seeded.counts,
      blobBytes: seeded.blobBytes,
      elapsedMs,
      preShapeDigest: initial.shapeDigest,
      postShapeDigest: post.shapeDigest,
      qualification: "non-authoritative; protected 0058 selector remains unavailable",
      rehearsalReceipt: "not-emitted",
      recovery:
        "quarantine this exact isolated D1 on uncertainty; never reset or replay it automatically",
    };
  } catch (error) {
    if (!targetMayHaveChanged) throw error;
    if (error instanceof DeployError && error.phase !== "preflight") throw error;
    throw mutationError(
      "0058 isolated D1 may have changed; inspect authoritative status and do not replay",
      error instanceof Error ? error.message : String(error),
    );
  } finally {
    unsealDirectory(root);
    if (temporary) {
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        // Local temporary cleanup must not replace the D1 mutation outcome.
      }
    }
  }
}
