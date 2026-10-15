import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildD1MigrationImport } from "../scripts/deploy/d1-migration-import.ts";
import { normalizeSnapshotDump } from "../scripts/deploy/d1-snapshot-restore.ts";
import { canonicalSchemaShape, readMigrationArtifact } from "../scripts/deploy/migrations.ts";
import { expectedWorkerSecrets } from "../scripts/deploy/realized-config.ts";
import {
  buildMoneyCutoverImportSql,
  type MoneyCutoverDispatchBinding,
  type MoneyReviewBinding,
  moneyCutoverBindingDigest,
  moneyUnitCutoverSourcePrefixDigest,
  readMoneyAggregateDigest,
  readMoneyFrozenDataDigest,
  readMoneyPreimageDigest,
} from "../scripts/deploy/schema-money-unit-cutover.ts";
import {
  loadMoneyUnitCutoverOptions,
  type MoneyUnitOwnerDependencies,
  readIntegrationMoneyUnitResumeState,
} from "../scripts/deploy/schema-money-unit-owner.ts";
import { type DeployTarget, loadTarget, parseDeployTarget } from "../scripts/deploy/target.ts";
import { expectedExactBindingClosure } from "../scripts/deploy/worker-state.ts";

const account = "a".repeat(32);
const generation = "b".repeat(32);
const name = `takoserver-i-${generation}`;
const databaseId = "11111111-1111-4111-8111-111111111111";
const deploymentId = "22222222-2222-4222-8222-222222222222";
const versionId = "33333333-3333-4333-8333-333333333333";
const source = "c".repeat(40);
const nativeBytes = "export default {fetch(){return new Response('ok')}};\n";
const resumeSource = "d".repeat(40);
const resumeBytes = "export default {fetch(){return new Response('usd-micros')}};\n";
const sourceDigest = "sha256:6f7c1016b7ffeeb7c02006cdb8e55dc7919bfc2aeaf04c090001dcf423454be2";
const reviewedAt = "2020-01-01T00:00:00.000Z";
const moneyTables = [
  "ledger",
  "wallet_credit_lots",
  "wallet_credit_allocations",
  "reseller_settlement_guards",
  "wallet_allocation_guards",
  "quotes",
  "reservations",
  "usage_statements",
  "usage_events",
  "idempotency",
  "reseller_settlement_intents",
  "stripe_events",
  "org_wallet_holds",
  "org_wallet_usage_records",
  "org_wallet_grant_snapshots",
  "org_wallet_pricing_revisions",
  "org_wallet_monthly_tariffs",
  "sponsorship_tenants",
  "sponsorship_resources",
  "sponsorship_credential_issuance_operations",
];

function sha(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
function id(index: number): string {
  return `${String(index).padStart(8, "0")}-0000-4000-8000-000000000000`;
}

const writerEpoch = sha("reviewed writer generation");

const target: DeployTarget = {
  kind: "takoserver.deploy-target@v2",
  environment: "integration",
  accountId: account,
  workerName: "takoserver-api-integration",
  d1: { databaseName: name, databaseId },
  r2: { bucketName: name },
  publicOrigin: "https://takoserver-api-integration.test.workers.dev",
  moneyCutoverWriterPolicy: "transaction-fenced-usd-micros-v1",
  moneyCutoverWriterEpoch: writerEpoch,
  signing: { currentKeyId: "key-current" },
  cloudflareProviderExecutor: {
    workerName: "private-cpe",
    gatewayWorkerName: "private-gateway",
    receiptAuthorityWorkerName: "private-receipt",
    dispatchNamespace: "private-dispatch",
    managedBaseDomain: "example.test",
    providerInstallationId: "installation",
  },
};

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(selectedTarget: DeployTarget = target) {
  const target = selectedTarget;
  const root = mkdtempSync(join(tmpdir(), "money-owner-"));
  roots.push(root);
  chmodSync(root, 0o700);
  const paths = {
    declaration: join(root, "declaration.json"),
    origin: join(root, "origin.json"),
    scope: join(root, "scope.json"),
    review: join(root, "review.json"),
    backup: join(root, "backup.sql"),
    maintenancePublication: join(root, "maintenance-publication.json"),
    resumePublication: join(root, "resume-publication.json"),
  };
  const write = (path: string, value: unknown) => {
    const bytes = JSON.stringify(value);
    writeFileSync(path, bytes, { mode: 0o600 });
    return sha(bytes);
  };
  const inventory = [
    "bun.lock",
    "package.json",
    "src/entry-cloudflare-managed-object-receipt-authority.ts",
    "src/entry-cloudflare-managed-worker-gateway.ts",
    "src/entry-cloudflare-provider-executor-complete.ts",
    "src/entry-cloudflare-v2-worker-tail.ts",
    "src/entry-cloudflare-worker.ts",
    "src/wfp/source.ts",
  ]
    .map((path) => `100644 blob ${"a".repeat(40)}\t${path}\0`)
    .join("");
  const origin = {
    kind: "takoserver.money-stage-origin-certificate@v1",
    state: "reviewed",
    reviewedAt,
    reviewEvidenceDigest: sha("origin-review-evidence"),
    accountId: account,
    databaseId,
    databaseName: name,
    bucketName: name,
    sourceCommit: source,
    generation,
    freshLineage: "v2-0092",
    migrationDigest: sourceDigest,
    appliedMigrationsCount: 92,
    schemaShapeDigest: sha("shape"),
    generationApplyLogDigest: sha("apply"),
    generationStatusLogDigest: sha("status"),
    statusReadback: "complete-0092",
    statusPresence: "both",
    statusTargetSelection: { d1: false, r2: false, databaseIdExact: null },
    reviewer: "origin-reviewer",
    reviewRef: "review://origin-0092",
  };
  const scope = {
    kind: "takoserver.money-private-writer-scope@v1",
    profile: "managed-wfp",
    state: "reviewed",
    reviewedAt,
    reviewEvidenceDigest: sha("private-scope-review-evidence"),
    accountId: account,
    databaseId,
    sourceInventoryDigest: sha(
      JSON.stringify([{ commit: source, sourceInventoryDigest: sha(inventory) }]),
    ),
    dependencyClosureDigest: sha("dependency-closure"),
    reviewedDmlTables: moneyTables,
    reviewedOperations: ["INSERT", "UPDATE", "DELETE"],
    reviewedIndirectChannels: [
      "dynamic-sql",
      "sql-string-concatenation",
      "sql-cte",
      "sql-trigger",
      "remote-host-api",
      "subrequests",
    ],
    components: ["private-cpe", "private-gateway", "private-receipt", "private-tail"].map(
      (workerName, index) => ({
        role: ["cpe", "gateway", "receipt-authority", "tail"][index],
        workerName,
        sourceCommit: source,
        moduleDigest: sha(nativeBytes),
        deploymentId: id(index + 2),
        versionId: id(index + 12),
        nativeBindingsDigest: sha("[]"),
      }),
    ),
    reviewer: "private-reviewer",
    reviewRef: "review://private-scope",
  };
  const declaration = {
    kind: "takoserver.money-cutover-owner-declaration@v1",
    phase: "freeze",
    accountId: account,
    databaseId,
    databaseName: name,
    bucketName: name,
    workerName: target.workerName,
    writerEpoch,
    maintenanceCommit: source,
    maintenanceModuleDigest: sha(nativeBytes),
    maintenanceSourceRoot: root,
    maintenancePublicationReceiptPath: paths.maintenancePublication,
    maintenancePublicationReceiptDigest: write(paths.maintenancePublication, {
      kind: "takoserver.money-public-worker-publication@v1",
      state: "reviewed",
      reviewedAt,
      reviewEvidenceDigest: sha("maintenance-publication-review-evidence"),
      phase: "maintenance",
      accountId: account,
      databaseId,
      workerName: target.workerName,
      sourceCommit: source,
      bundleDigest: sha(nativeBytes),
      artifactDigest: sha("sealed-maintenance"),
      artifactBytes: 100,
      artifactFiles: 2,
      deploymentId,
      versionId,
      surface: "takoserver-worker-authority-cutover",
      resultKind: "takoserver.worker-apply@v2",
      resultDigest: sha("maintenance-result"),
      ownerGateDigest: sha("maintenance-gate"),
      reviewer: "publication-reviewer",
      reviewRef: "review://maintenance-publication",
    }),
    originCertificatePath: paths.origin,
    originCertificateDigest: write(paths.origin, origin),
    privateWriterScopePath: paths.scope,
    privateWriterScopeDigest: write(paths.scope, scope),
    privateSourceRoot: root,
    reviewEvidencePath: paths.review,
    backupPath: paths.backup,
    custodyDirectory: root,
    outputDirectory: root,
    leaseRoot: root,
  };
  write(paths.declaration, declaration);
  const requests: string[] = [];
  let deploymentPercentage = 100;
  let publicMode = true;
  let resumeFrozen = false;
  let privateDigest = sha(nativeBytes);
  let extraPublicBinding = false;
  let publicEpochBinding = writerEpoch;
  const state = {
    async workerDeployments(workerName: string) {
      requests.push(`deployment:${workerName}`);
      const index = [
        target.workerName,
        "private-cpe",
        "private-gateway",
        "private-receipt",
        "private-tail",
      ].indexOf(workerName);
      return [
        {
          id: index < 1 ? (publicMode ? deploymentId : id(45)) : id(index + 1),
          created_on: "2026-10-14T00:00:00Z",
          versions: [
            {
              version_id: index < 1 ? (publicMode ? versionId : id(44)) : id(index + 11),
              percentage: deploymentPercentage,
            },
          ],
        },
      ];
    },
    async workerVersion(workerName: string, activeVersion: string) {
      requests.push(`version:${workerName}`);
      const digest =
        workerName === target.workerName
          ? publicMode
            ? sha(nativeBytes)
            : sha(resumeBytes)
          : privateDigest;
      const selected = publicMode
        ? { ...target, schemaMaintenanceMode: "pre-wallet-usd-micros-quiesced" as const }
        : target;
      const expected = expectedExactBindingClosure(selected, {
        workerArtifactDigest: digest as `sha256:${string}`,
      });
      return {
        id: activeVersion,
        annotations: {
          "workers/message": `takoserver-worker:${workerName === target.workerName && !publicMode ? resumeSource : source}:${digest.slice(7)}`,
          "workers/triggered_by": "version_upload",
        },
        resources: {
          bindings:
            workerName === target.workerName
              ? Object.entries(expected)
                  .flatMap(([binding, requirement]) =>
                    requirement === null
                      ? []
                      : [
                          {
                            name: binding,
                            type: requirement.type,
                            ...requirement.fields,
                            ...(binding === "TAKOSERVER_MONEY_CUTOVER_WRITER_EPOCH"
                              ? { text: publicEpochBinding }
                              : {}),
                          },
                        ],
                  )
                  .concat(
                    extraPublicBinding
                      ? [{ name: "UNREVIEWED_PRIVATE_SERVICE", type: "service" }]
                      : [],
                  )
              : [],
        },
      };
    },
    async workerVersionWithModules(workerName: string) {
      requests.push(`modules:${workerName}`);
      return {
        main_module: "worker.js",
        modules: [
          {
            name: "worker.js",
            content_type: "application/javascript+module",
            content_base64: Buffer.from(
              workerName === target.workerName && !publicMode ? resumeBytes : nativeBytes,
            ).toString("base64"),
          },
        ],
      };
    },
    async workerSecrets() {
      return expectedWorkerSecrets(target).map((binding) => ({
        name: binding,
        type: "secret_text",
      }));
    },
    async workerDomains() {
      return [];
    },
    async workerSubdomain() {
      return { enabled: true, previewsEnabled: false };
    },
    async workerAccountSubdomain() {
      return "test";
    },
  };
  const storage = {
    async getD1(selectedId: string) {
      requests.push(`d1:${selectedId}`);
      return { uuid: databaseId, name };
    },
    async getR2(selectedName: string) {
      requests.push(`r2:${selectedName}`);
      return { name };
    },
  };
  const fetcher = async (url: string): Promise<Response> => {
    requests.push(`http:${url}`);
    if (publicMode)
      return Response.json(
        {
          error: {
            code: "backend_unavailable",
            message: "Host is quiesced for the wallet USD-micros schema maintenance transition",
            details: { reason: "runtime-configuration" },
          },
        },
        { status: 503, headers: { "cache-control": "no-store", "retry-after": "60" } },
      );
    if (resumeFrozen && url.endsWith("/healthz"))
      return Response.json(
        {
          error: {
            code: "backend_unavailable",
            message: "Host is frozen for the wallet USD-micros writer transition",
            details: { reason: "money-cutover-freeze" },
          },
        },
        { status: 503, headers: { "cache-control": "no-store", "retry-after": "60" } },
      );
    if (url.endsWith("/.well-known/takoserver"))
      return Response.json({
        product: "takoserver",
        apiVersion: "v1",
        endpoints: { api: target.publicOrigin, openapi: `${target.publicOrigin}/openapi.json` },
      });
    if (url.endsWith("/openapi.json"))
      return Response.json({ servers: [{ url: target.publicOrigin }] });
    return Response.json({ status: "ok" });
  };
  const run = async (command: readonly string[]) => {
    requests.push(`git:${command.slice(3).join(" ")}`);
    if (command[3] === "rev-parse")
      return {
        exitCode: 0,
        stdout: `${command[4] === "HEAD" ? (publicMode ? source : resumeSource) : root}\n`,
        stderr: "",
      };
    if (command[3] === "status") return { exitCode: 0, stdout: "", stderr: "" };
    if (command[3] === "ls-remote")
      return { exitCode: 0, stdout: `${resumeSource}\trefs/heads/main\n`, stderr: "" };
    if (command[3] === "show")
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          name:
            target.cloudflareProviderExecutor === undefined
              ? "@takoserver/core"
              : "@takoserver/private-composition",
        }),
        stderr: "",
      };
    if (command[3] === "ls-tree") return { exitCode: 0, stdout: inventory, stderr: "" };
    if (command[3] === "grep") return { exitCode: 1, stdout: "", stderr: "" };
    throw new Error("unexpected Git command");
  };
  const publicArtifactBuilder = async (_sourceRoot: string, commit: string) => ({
    bundleDigest: commit === source ? sha(nativeBytes) : sha(resumeBytes),
    artifactDigest: commit === source ? sha("sealed-maintenance") : sha("sealed-resume"),
    artifactBytes: 100,
    artifactFiles: 2,
  });
  return {
    root,
    paths,
    origin,
    scope,
    inventory,
    declaration,
    state,
    storage,
    fetcher,
    requests,
    write,
    run,
    publicArtifactBuilder,
    setPercentage(value: number) {
      deploymentPercentage = value;
    },
    setPrivateDigest(value: string) {
      privateDigest = value;
    },
    setExtraPublicBinding(value: boolean) {
      extraPublicBinding = value;
    },
    setPublicEpochBinding(value: string) {
      publicEpochBinding = value;
    },
    setPublicMode(value: boolean) {
      publicMode = value;
    },
    setResumeFrozen(value: boolean) {
      resumeFrozen = value;
    },
  };
}

function standaloneFixture(operatorIdentity?: NonNullable<DeployTarget["operatorIdentity"]>) {
  const { cloudflareProviderExecutor: _managedExecutor, ...baseTarget } = target;
  const standaloneTarget: DeployTarget = {
    ...baseTarget,
    ...(operatorIdentity === undefined ? {} : { operatorIdentity }),
  };
  const f = fixture(standaloneTarget);
  const standaloneScope = {
    ...f.scope,
    profile: "standalone-host",
    publicSourceCommit: source,
    sourceInventoryDigest: sha(f.inventory),
    components: [],
  };
  const { privateSourceRoot: _privateSourceRoot, ...declaration } = f.declaration;
  const standaloneDeclaration = {
    ...declaration,
    privateWriterScopeDigest: f.write(f.paths.scope, standaloneScope),
  };
  f.write(f.paths.declaration, standaloneDeclaration);
  return {
    ...f,
    target: standaloneTarget,
    scope: standaloneScope,
    declaration: standaloneDeclaration,
  };
}

/** Full owner reader and held custody; all native ports are controlled component fixtures. */
async function resumeDependencyFixture(mode: "clear" | "replace") {
  const f = standaloneFixture();
  f.setPublicMode(false);
  f.setResumeFrozen(true);
  const resumeRoot = join(f.root, "resume-source");
  mkdirSync(resumeRoot, { mode: 0o700 });
  const files = readMigrationArtifact().files;
  const database = new Database(":memory:");
  const original = normalizeSnapshotDump(
    Buffer.from(buildD1MigrationImport(files.slice(0, 92), { freshLedger: true }).sql),
  );
  database.exec(original.sql);
  writeFileSync(f.paths.backup, original.sql, { mode: 0o600 });
  const manifestPath = join(f.root, "classifications.json");
  writeFileSync(manifestPath, "[]\n", { mode: 0o600 });
  const resumePublicationReceiptDigest = f.write(f.paths.resumePublication, {
    kind: "takoserver.money-public-worker-publication@v1",
    state: "reviewed",
    reviewedAt,
    reviewEvidenceDigest: sha("resume-publication-review-evidence"),
    phase: "resume",
    accountId: account,
    databaseId,
    workerName: f.target.workerName,
    sourceCommit: resumeSource,
    bundleDigest: sha(resumeBytes),
    artifactDigest: sha("sealed-resume"),
    artifactBytes: 100,
    artifactFiles: 2,
    deploymentId: id(45),
    versionId: id(44),
    surface: "takoserver-worker-authority-cutover",
    resultKind: "takoserver.worker-closure-transition-apply@v1",
    resultDigest: sha("resume-result"),
    ownerGateDigest: sha("resume-gate"),
    reviewer: "publication-reviewer",
    reviewRef: "review://resume-publication",
  });
  f.write(f.paths.declaration, {
    ...f.declaration,
    phase: "resume",
    resumeCommit: resumeSource,
    resumeModuleDigest: sha(resumeBytes),
    resumeSourceRoot: resumeRoot,
    resumePublicationReceiptPath: f.paths.resumePublication,
    resumePublicationReceiptDigest,
    classificationManifestPath: manifestPath,
    classificationManifestDigest: sha("[]\n"),
  });
  const owner = await loadMoneyUnitCutoverOptions(f.paths.declaration, f.target, f);
  const origin = await owner.stageOriginProof();
  const identity = await owner.storageIdentityRead();
  const originDigest = sha(JSON.stringify(origin));
  f.write(`${f.paths.backup}.identity.json`, {
    kind: "takoserver.money-protected-backup@v1",
    accountId: account,
    databaseId,
    databaseName: name,
    originDigest,
    sourceDigest,
    backupDigest: original.digest,
  });
  const local = {
    query: async (_phase: unknown, _description: unknown, sql: string) =>
      database.query(sql).all() as Record<string, unknown>[],
  };
  const preimageDigest = await readMoneyPreimageDigest(local, "preflight");
  const aggregateDigest = await readMoneyAggregateDigest(local, "preflight");
  const financialDigest = await readMoneyFrozenDataDigest(local, "preflight");
  const writerDigest = sha("controlled prior native maintenance proof");
  const anchor = sha(
    JSON.stringify({
      kind: "takoserver.money-freeze-anchor@v1",
      target: identity,
      originDigest,
      backupDigest: original.digest,
      preimageDigest,
      aggregateDigest,
      financialDigest,
      writerDigest,
      writerEpoch,
      sourceDigest,
    }),
  );
  const schema = () => {
    const applied = (
      database.query("SELECT name FROM d1_migrations ORDER BY id").all() as { name: string }[]
    ).map((row) => row.name);
    const shape = canonicalSchemaShape(
      database
        .query(
          "SELECT type, name, tbl_name, COALESCE(sql, '') AS sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' ORDER BY type, name",
        )
        .all() as Record<string, unknown>[],
    );
    return { applied, shape, shapeDigest: sha(shape) };
  };
  let predecessor = origin.terminalCustodyDigest;
  for (const phase of ["freeze", "prepare", "classify", "convert"] as const) {
    const beforeShapeDigest = schema().shapeDigest;
    const sql = buildMoneyCutoverImportSql({
      phase,
      files,
      anchor,
      originDigest,
      backupDigest: original.digest,
      writerDigest,
      writerEpoch,
      classifications: [],
    });
    const directory = join(f.root, `money-${phase}-fixture`);
    mkdirSync(directory, { mode: 0o700 });
    const sealedImportPath = join(directory, "import.sql");
    writeFileSync(sealedImportPath, sql, { mode: 0o600 });
    const binding: MoneyCutoverDispatchBinding = {
      kind: "takoserver.money-cutover-dispatch@v1",
      phase,
      accountId: account,
      databaseId,
      databaseName: name,
      originDigest,
      predecessorCustodyDigest: predecessor,
      sourceCommit: source,
      sourceDigest: moneyUnitCutoverSourcePrefixDigest(files, phase === "convert" ? 94 : 93),
      importDigest: sha(sql),
      backupDigest: original.digest,
      preimageDigest,
      aggregateDigest,
      classificationDigest: sha("[]\n"),
      writerDigest,
      resumeDigest: sha("no-resume-worker"),
      writerEpoch,
      reviewDigest: sha("temporary-review-digest"),
      beforeShapeDigest,
      afterSchemaPhase:
        phase === "freeze" ? "0092-fenced" : phase === "convert" ? "0094-fenced" : "0093-fenced",
      sealedImportPath,
    };
    const reviewBinding: MoneyReviewBinding = {
      kind: "takoserver.money-review-binding@v1",
      phase,
      accountId: account,
      databaseId,
      originDigest,
      predecessorCustodyDigest: predecessor,
      sourceCommit: source,
      sourceDigest: binding.sourceDigest,
      importDigest: binding.importDigest,
      backupDigest: binding.backupDigest,
      preimageDigest,
      aggregateDigest,
      classificationDigest: binding.classificationDigest,
      writerDigest,
      resumeDigest: binding.resumeDigest,
      writerEpoch,
    };
    const review = {
      kind: "takoserver.money-independent-review@v1",
      state: "reviewed",
      reviewedAt,
      reviewEvidenceDigest: sha("controlled component review"),
      reviewer: "component-reviewer",
      reviewRef: "review://controlled-component",
      bindingDigest: moneyCutoverBindingDigest(reviewBinding),
      evidenceDigest: sha("controlled component review"),
    };
    f.write(f.paths.review, review);
    const reviewedBinding = { ...binding, reviewDigest: sha(JSON.stringify(review)) };
    await owner.custody.dispatch(reviewedBinding);
    database.exec(`BEGIN TRANSACTION;\n${sql}\nCOMMIT;`);
    const post = schema();
    const terminal = await owner.custody.terminal(
      reviewedBinding,
      sha(
        JSON.stringify({
          applied: post.applied,
          shapeDigest: post.shapeDigest,
          preimageDigest,
          aggregateDigest,
        }),
      ),
    );
    predecessor = sha(JSON.stringify(terminal));
  }
  let builds = 0;
  let lateCallbacks = 0;
  let d1Reads = 0;
  type MutableDependencies = {
    -readonly [K in keyof MoneyUnitOwnerDependencies]: MoneyUnitOwnerDependencies[K];
  };
  const dependencies: MutableDependencies = {
    state: {
      ...f.state,
      async workerDeployments(workerName: string) {
        const history = await f.state.workerDeployments(workerName);
        if (builds === 2) {
          await Promise.resolve();
          lateCallbacks++;
          if (mode === "clear") {
            delete dependencies.state;
            delete dependencies.storage;
            delete dependencies.fetcher;
            delete dependencies.publicArtifactBuilder;
          } else {
            dependencies.state = {
              ...f.state,
              workerDeployments: async () => {
                throw new Error("replacement state consumed");
              },
            };
            dependencies.storage = {
              getD1: async () => {
                throw new Error("replacement D1 consumed");
              },
              getR2: async () => {
                throw new Error("replacement R2 consumed");
              },
            };
            dependencies.fetcher = async () => {
              throw new Error("replacement fetcher consumed");
            };
            dependencies.publicArtifactBuilder = async () => {
              throw new Error("replacement builder consumed");
            };
          }
        }
        return history;
      },
    },
    storage: f.storage,
    fetcher: f.fetcher,
    publicArtifactBuilder: async (root: string, commit: string) => {
      builds++;
      return f.publicArtifactBuilder(root, commit);
    },
    cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "controlled-component-token" },
    run: async (command) => {
      if (command[0] === "git" && command[3] === "rev-parse") {
        const selectedRoot = command[2];
        return {
          exitCode: 0,
          stdout: `${command[4] === "HEAD" ? (selectedRoot === resumeRoot ? resumeSource : source) : selectedRoot}\n`,
          stderr: "",
        };
      }
      const commandIndex = command.indexOf("--command");
      if (command.includes("d1") && command.includes("execute") && commandIndex >= 0) {
        const sql = command[commandIndex + 1];
        if (!sql || !/^(?:SELECT\b|PRAGMA\b)/u.test(sql)) throw new Error("non-read D1 command");
        d1Reads++;
        return {
          exitCode: 0,
          stdout: JSON.stringify([{ success: true, results: database.query(sql).all() }]),
          stderr: "",
        };
      }
      return f.run(command);
    },
  };
  return {
    f,
    dependencies,
    reads: () => d1Reads,
    builds: () => builds,
    lateCallbacks: () => lateCallbacks,
    close: () => database.close(),
  };
}

describe("money unit owner adapter", () => {
  for (const mode of ["clear", "replace"] as const) {
    test(`money resume dependency snapshot preserves component taint when late ports ${mode}`, async () => {
      const fixture = await resumeDependencyFixture(mode);
      try {
        const result = await readIntegrationMoneyUnitResumeState(
          { selectedTarget: fixture.f.target, declarationPath: fixture.f.paths.declaration },
          fixture.dependencies,
        );
        expect(fixture.builds()).toBe(2);
        expect(fixture.lateCallbacks()).toBe(1);
        expect(fixture.reads()).toBeGreaterThan(0);
        expect(result.schemaPhase).toBe("0094-fenced");
        expect(result.normalHostReady).toBe(false);
        expect(result.qualification).toBe("component-simulation-only");
      } finally {
        fixture.close();
      }
    });
  }

  test("money resume read admits prefixed policy only under its explicit read selector", async () => {
    const f = fixture();
    const { cloudflareProviderExecutor: _private, ...standalone } = target;
    const pair = `integration-ts-${generation}`;
    const selected = {
      ...standalone,
      d1: { databaseId, databaseName: pair },
      r2: { bucketName: pair },
      takoformV2: {
        storageLineage: "v2-0092",
        config: JSON.stringify({
          documentation: "https://docs.example.test",
          authenticationDocumentation: "https://auth.example.test",
        }),
      },
    };
    expect(() => parseDeployTarget(selected, "component target", "integration")).toThrow(
      "money cutover writer policy",
    );
    const readTarget = parseDeployTarget(
      selected,
      "component target",
      "integration",
      "money-resume-read",
    );
    expect(readTarget.d1.databaseName).toBe(pair);
    const path = join(f.root, "read-target.json");
    f.write(path, selected);
    expect(loadTarget(path, "integration", "money-resume-read")).toEqual(readTarget);
    expect(() => loadTarget(path, "integration")).toThrow("money cutover writer policy");
    await expect(loadMoneyUnitCutoverOptions(f.paths.declaration, readTarget, f)).rejects.toThrow(
      "existing legacy staging origin",
    );
    expect(f.requests).toEqual([]);
  });

  test("money resume read refuses a legacy certificate as original origin for the new namespace", async () => {
    const f = fixture();
    const pair = `integration-ts-${generation}`;
    const selected = {
      ...target,
      d1: { databaseId, databaseName: pair },
      r2: { bucketName: pair },
    };
    await expect(
      readIntegrationMoneyUnitResumeState(
        { selectedTarget: selected, declarationPath: f.paths.declaration },
        f,
      ),
    ).rejects.toThrow("original-origin locators");
    expect(f.requests).toEqual([]);
  });

  test("money resume read refuses JSON proof promotion before touching owner inputs", async () => {
    const f = fixture();
    const request = {
      selectedTarget: target,
      declarationPath: f.paths.declaration,
      nativeResumeProof: { ready: true, schemaPhase: "0094" },
    };
    await expect(readIntegrationMoneyUnitResumeState(request, f)).rejects.toThrow(
      "original-origin locators",
    );
    expect(f.requests).toEqual([]);
  });

  test("accepts the qualified authority closure receipt and rejects other publication kinds", async () => {
    const f = standaloneFixture();
    const receipt = JSON.parse(readFileSync(f.paths.maintenancePublication, "utf8"));
    const maintenancePublicationReceiptDigest = f.write(f.paths.maintenancePublication, {
      ...receipt,
      resultKind: "takoserver.worker-closure-transition-apply@v1",
    });
    f.write(f.paths.declaration, { ...f.declaration, maintenancePublicationReceiptDigest });
    const options = await loadMoneyUnitCutoverOptions(f.paths.declaration, f.target, f);
    expect(await options.maintenanceProof()).toMatchObject({ privateMoneyWriters: 0 });
    const unknownDigest = f.write(f.paths.maintenancePublication, {
      ...receipt,
      resultKind: "takoserver.unqualified-publication@v1",
    });
    f.write(f.paths.declaration, {
      ...f.declaration,
      maintenancePublicationReceiptDigest: unknownDigest,
    });
    await expect(loadMoneyUnitCutoverOptions(f.paths.declaration, f.target, f)).rejects.toThrow(
      "terminal publication",
    );
  });

  test("qualifies standalone public-key identity without adding a private writer", async () => {
    const f = standaloneFixture({
      publicJwk: { kty: "OKP", crv: "Ed25519", x: "A".repeat(43) },
    });
    const options = await loadMoneyUnitCutoverOptions(f.paths.declaration, f.target, f);
    expect(await options.maintenanceProof()).toMatchObject({
      privateMoneyWriters: 0,
      privateDeploymentsDigest: sha("[]"),
    });
    expect(f.requests.some((item) => item.includes("private-"))).toBe(false);
    f.setExtraPublicBinding(true);
    await expect(options.maintenanceProof()).rejects.toThrow();
  });

  test("qualifies reviewed standalone Host without private Git or private native inventory", async () => {
    const f = standaloneFixture();
    const options = await loadMoneyUnitCutoverOptions(f.paths.declaration, f.target, f);
    expect(await options.storageIdentityRead()).toEqual({
      accountId: account,
      databaseId,
      databaseName: name,
      bucketName: name,
    });
    expect(await options.maintenanceProof()).toMatchObject({
      privateMoneyWriters: 0,
      privateScopeDigest: f.declaration.privateWriterScopeDigest,
      privateSourceInventoryDigest: sha(f.inventory),
      privateDeploymentsDigest: sha("[]"),
    });
    expect(
      f.requests.some((item) => item.includes("private-") || item.startsWith("git:grep")),
    ).toBe(false);
    expect(f.requests).toContain(`deployment:${f.target.workerName}`);
    expect(f.requests).toContain(`d1:${databaseId}`);
    expect(f.requests).toContain(`r2:${name}`);
  });

  test("standalone scope rejects target authority, extra native binding, and source inventory drift", async () => {
    const authority = standaloneFixture();
    const managedExecutor = target.cloudflareProviderExecutor;
    if (managedExecutor === undefined) throw new Error("managed fixture must have an executor");
    await expect(
      loadMoneyUnitCutoverOptions(
        authority.paths.declaration,
        {
          ...authority.target,
          cloudflareProviderExecutor: managedExecutor,
        },
        authority,
      ),
    ).rejects.toThrow();
    expect(authority.requests).toEqual([]);
    const extra = standaloneFixture();
    const options = await loadMoneyUnitCutoverOptions(extra.paths.declaration, extra.target, extra);
    extra.setExtraPublicBinding(true);
    await expect(options.maintenanceProof()).rejects.toThrow();
    const mismatched = standaloneFixture();
    const sourceInventoryDigest = sha("unreviewed-source");
    const privateWriterScopeDigest = mismatched.write(mismatched.paths.scope, {
      ...mismatched.scope,
      sourceInventoryDigest,
    });
    mismatched.write(mismatched.paths.declaration, {
      ...mismatched.declaration,
      privateWriterScopeDigest,
    });
    const drift = await loadMoneyUnitCutoverOptions(
      mismatched.paths.declaration,
      mismatched.target,
      mismatched,
    );
    await expect(drift.maintenanceProof()).rejects.toThrow("standalone Host source differs");
  });

  test("refuses pending origin before any provider read", async () => {
    const f = fixture();
    const originCertificateDigest = f.write(f.paths.origin, {
      ...f.origin,
      state: "pending",
      reviewedAt: null,
      reviewEvidenceDigest: null,
      reviewer: "PENDING independent review",
      reviewRef: "pending:origin-review",
    });
    f.write(f.paths.declaration, { ...f.declaration, originCertificateDigest });
    await expect(loadMoneyUnitCutoverOptions(f.paths.declaration, target, f)).rejects.toThrow(
      "origin certificate",
    );
    const futureDigest = f.write(f.paths.origin, {
      ...f.origin,
      reviewedAt: "2999-01-01T00:00:00.000Z",
    });
    f.write(f.paths.declaration, { ...f.declaration, originCertificateDigest: futureDigest });
    await expect(loadMoneyUnitCutoverOptions(f.paths.declaration, target, f)).rejects.toThrow(
      "origin certificate",
    );
    const placeholderDigest = f.write(f.paths.origin, {
      ...f.origin,
      reviewer: "PENDING independent review",
      reviewRef: "pending:origin-review",
    });
    f.write(f.paths.declaration, { ...f.declaration, originCertificateDigest: placeholderDigest });
    await expect(loadMoneyUnitCutoverOptions(f.paths.declaration, target, f)).rejects.toThrow(
      "origin certificate",
    );
    expect(f.requests).toEqual([]);
  });

  test("rejects pending private and public publication review records before provider reads", async () => {
    const privateFixture = fixture();
    const privateWriterScopeDigest = privateFixture.write(privateFixture.paths.scope, {
      ...privateFixture.scope,
      state: "pending",
      reviewedAt: null,
      reviewEvidenceDigest: null,
    });
    privateFixture.write(privateFixture.paths.declaration, {
      ...privateFixture.declaration,
      privateWriterScopeDigest,
    });
    await expect(
      loadMoneyUnitCutoverOptions(privateFixture.paths.declaration, target, privateFixture),
    ).rejects.toThrow("private writer scope");
    expect(privateFixture.requests).toEqual([]);

    const publicFixture = fixture();
    const publication = JSON.parse(
      readFileSync(publicFixture.paths.maintenancePublication, "utf8"),
    );
    const maintenancePublicationReceiptDigest = publicFixture.write(
      publicFixture.paths.maintenancePublication,
      {
        ...publication,
        state: "pending",
        reviewedAt: null,
        reviewEvidenceDigest: null,
      },
    );
    publicFixture.write(publicFixture.paths.declaration, {
      ...publicFixture.declaration,
      maintenancePublicationReceiptDigest,
    });
    await expect(
      loadMoneyUnitCutoverOptions(publicFixture.paths.declaration, target, publicFixture),
    ).rejects.toThrow("terminal publication");
    expect(publicFixture.requests).toEqual([]);
  });

  test("binds protected positive staging origin to exact native storage and four reviewed private versions", async () => {
    const f = fixture();
    const options = await loadMoneyUnitCutoverOptions(f.paths.declaration, target, f);
    expect(await options.stageOriginProof()).toMatchObject({
      state: "terminal",
      sourceDigest,
      databaseId,
    });
    expect(await options.storageIdentityRead()).toEqual({
      accountId: account,
      databaseId,
      databaseName: name,
      bucketName: name,
    });
    expect(await options.maintenanceProof()).toMatchObject({
      mode: "pre-wallet-usd-micros-quiesced",
      trafficPercent: 100,
      privateMoneyWriters: 0,
      moduleDigest: sha(nativeBytes),
      privateScopeDigest: f.declaration.privateWriterScopeDigest,
      privateSourceInventoryDigest: f.scope.sourceInventoryDigest,
      privateDependencyClosureDigest: f.scope.dependencyClosureDigest,
      privateDeploymentsDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
    });
    expect(f.requests.filter((item) => item.startsWith("deployment:private-"))).toHaveLength(8);
    expect(f.requests.some((item) => item.includes("production"))).toBe(false);
  });

  test("refuses a different native or declaration Writer epoch before cutover proof", async () => {
    const f = fixture();
    const options = await loadMoneyUnitCutoverOptions(f.paths.declaration, target, f);
    f.setPublicEpochBinding(sha("different native Writer generation"));
    await expect(options.maintenanceProof()).rejects.toThrow();
    const other = fixture();
    await expect(
      loadMoneyUnitCutoverOptions(
        other.paths.declaration,
        {
          ...target,
          moneyCutoverWriterEpoch: sha("different target Writer generation"),
        },
        other,
      ),
    ).rejects.toThrow("declaration");
    expect(other.requests).toEqual([]);
  });

  test("rejects cross-target and production before any provider read", async () => {
    const f = fixture();
    await expect(
      loadMoneyUnitCutoverOptions(
        f.paths.declaration,
        { ...target, d1: { ...target.d1, databaseId: id(99) } },
        f,
      ),
    ).rejects.toThrow("declaration");
    await expect(
      loadMoneyUnitCutoverOptions(f.paths.declaration, { ...target, environment: "production" }, f),
    ).rejects.toThrow("declaration");
    await expect(
      loadMoneyUnitCutoverOptions(
        f.paths.declaration,
        { ...target, publicOrigin: "https://stage.example.test" },
        f,
      ),
    ).rejects.toThrow("declaration");
    expect(f.requests).toEqual([]);
  });

  test("refuses partial traffic, unknown private module, and changed protected scope", async () => {
    const f = fixture();
    const options = await loadMoneyUnitCutoverOptions(f.paths.declaration, target, f);
    f.setPercentage(99);
    await expect(options.maintenanceProof?.()).rejects.toThrow();
    f.setPercentage(100);
    f.setPrivateDigest(sha("unknown-private"));
    await expect(options.maintenanceProof?.()).rejects.toThrow("reviewed source/module");
    f.setPrivateDigest(sha(nativeBytes));
    f.write(f.paths.scope, { ...f.scope, reviewer: "replaced-reviewer" });
    await expect(options.maintenanceProof?.()).rejects.toThrow("digest differs");
  });

  test("rejects dirty public checkout, invented source bytes, and unreviewed publication", async () => {
    const f = fixture();
    const dirty = await loadMoneyUnitCutoverOptions(f.paths.declaration, target, {
      ...f,
      async run(command) {
        const result = await f.run(command);
        return command[3] === "status"
          ? { ...result, stdout: " M src/entry-cloudflare-worker.ts\n" }
          : result;
      },
    });
    await expect(dirty.maintenanceProof()).rejects.toThrow("exact clean reviewed commit");
    const fabricated = await loadMoneyUnitCutoverOptions(f.paths.declaration, target, {
      ...f,
      async publicArtifactBuilder() {
        return {
          bundleDigest: sha("invented"),
          artifactDigest: sha("sealed-maintenance"),
          artifactBytes: 100,
          artifactFiles: 2,
        };
      },
    });
    await expect(fabricated.maintenanceProof()).rejects.toThrow("source-built bytes differ");
    const mismatched = f.write(f.paths.maintenancePublication, {
      kind: "takoserver.money-public-worker-publication@v1",
      state: "reviewed",
      reviewedAt,
      reviewEvidenceDigest: sha("maintenance-publication-review-evidence"),
      phase: "maintenance",
      accountId: account,
      databaseId,
      workerName: target.workerName,
      sourceCommit: source,
      bundleDigest: sha(nativeBytes),
      artifactDigest: sha("unreviewed-artifact"),
      artifactBytes: 100,
      artifactFiles: 2,
      deploymentId,
      versionId,
      surface: "takoserver-worker-authority-cutover",
      resultKind: "takoserver.worker-apply@v2",
      resultDigest: sha("maintenance-result"),
      ownerGateDigest: sha("maintenance-gate"),
      reviewer: "publication-reviewer",
      reviewRef: "review://maintenance-publication",
    });
    f.write(f.paths.declaration, {
      ...f.declaration,
      maintenancePublicationReceiptDigest: mismatched,
    });
    const unreviewed = await loadMoneyUnitCutoverOptions(f.paths.declaration, target, f);
    await expect(unreviewed.maintenanceProof()).rejects.toThrow("terminal publication");
  });

  test("recomputes the pinned private archive and refuses direct money DML", async () => {
    const f = fixture();
    const mismatch = await loadMoneyUnitCutoverOptions(f.paths.declaration, target, {
      ...f,
      async run(command) {
        const result = await f.run(command);
        return command[3] === "ls-tree"
          ? { ...result, stdout: result.stdout.replace("a".repeat(40), "b".repeat(40)) }
          : result;
      },
    });
    await expect(mismatch.maintenanceProof()).rejects.toThrow("reviewed inventory");
    const directDml = await loadMoneyUnitCutoverOptions(f.paths.declaration, target, {
      ...f,
      async run(command) {
        const result = await f.run(command);
        return command[3] === "grep" ? { ...result, exitCode: 0 } : result;
      },
    });
    await expect(directDml.maintenanceProof()).rejects.toThrow("direct money-table DML");
  });

  test("resume requires a different native source and normal product readback", async () => {
    const f = fixture();
    f.setPublicMode(false);
    const resumePublicationReceiptDigest = f.write(f.paths.resumePublication, {
      kind: "takoserver.money-public-worker-publication@v1",
      state: "reviewed",
      reviewedAt,
      reviewEvidenceDigest: sha("resume-publication-review-evidence"),
      phase: "resume",
      accountId: account,
      databaseId,
      workerName: target.workerName,
      sourceCommit: resumeSource,
      bundleDigest: sha(resumeBytes),
      artifactDigest: sha("sealed-resume"),
      artifactBytes: 100,
      artifactFiles: 2,
      deploymentId: id(45),
      versionId: id(44),
      surface: "takoserver-worker-authority-cutover",
      resultKind: "takoserver.worker-closure-transition-apply@v1",
      resultDigest: sha("resume-result"),
      ownerGateDigest: sha("resume-gate"),
      reviewer: "publication-reviewer",
      reviewRef: "review://resume-publication",
    });
    f.write(f.paths.declaration, {
      ...f.declaration,
      phase: "resume",
      resumeCommit: resumeSource,
      resumeModuleDigest: sha(resumeBytes),
      resumeSourceRoot: f.root,
      resumePublicationReceiptPath: f.paths.resumePublication,
      resumePublicationReceiptDigest,
    });
    const options = await loadMoneyUnitCutoverOptions(f.paths.declaration, target, f);
    f.setResumeFrozen(true);
    expect(await options.resumeProof?.()).toMatchObject({
      sourceCommit: resumeSource,
      moduleDigest: sha(resumeBytes),
      writerContainmentPolicy: "transaction-fenced-usd-micros-v1",
    });
    await options.resumeHealthRead?.("guarded");
    f.setResumeFrozen(false);
    await options.resumeHealthRead?.("healthy");
    expect(f.requests).toContain(`http:${target.publicOrigin}/.well-known/takoserver`);
    f.setPublicMode(true);
    await expect(options.resumeProof?.()).rejects.toThrow();
  });

  test("keeps dispatch and terminal custody immutable and refuses absent review", async () => {
    const f = fixture();
    const options = await loadMoneyUnitCutoverOptions(f.paths.declaration, target, f);
    const sealedImportPath = join(f.root, "import.sql");
    writeFileSync(sealedImportPath, "import", { mode: 0o600 });
    const binding = {
      kind: "takoserver.money-cutover-dispatch@v1",
      phase: "freeze",
      accountId: account,
      databaseId,
      databaseName: name,
      originDigest: sha("origin"),
      sourceCommit: source,
      sourceDigest,
      importDigest: sha("import"),
      backupDigest: sha("backup"),
      preimageDigest: sha("preimage"),
      predecessorCustodyDigest: sha("previous"),
      aggregateDigest: sha("aggregate"),
      classificationDigest: sha("classifications"),
      writerDigest: sha("writer"),
      writerEpoch,
      reviewDigest: sha("review"),
      beforeShapeDigest: sha("shape"),
      resumeDigest: sha("none"),
      afterSchemaPhase: "0092-fenced",
      sealedImportPath,
    } as const;
    expect(await options.custody.read("freeze")).toBeNull();
    expect(await options.custody.readDispatch("freeze")).toBeNull();
    const dispatch = await options.custody.dispatch(binding);
    expect(dispatch.state).toBe("dispatched");
    expect(await options.custody.readDispatch("freeze")).toEqual(binding);
    await expect(options.custody.dispatch(binding)).rejects.toThrow("already exists");
    writeFileSync(sealedImportPath, "tampered");
    await expect(options.custody.readDispatch("freeze")).rejects.toThrow(
      "sealed import SQL differs",
    );
    writeFileSync(sealedImportPath, "import");
    expect((await options.custody.terminal(binding, sha("post"))).state).toBe("terminal");
    await expect(options.custody.terminal(binding, sha("post"))).rejects.toThrow(
      "cannot reconcile",
    );
    expect(
      await options.independentReview?.({
        kind: "takoserver.money-review-binding@v1",
        phase: "freeze",
        accountId: account,
        databaseId,
        originDigest: sha("origin"),
        predecessorCustodyDigest: sha("previous"),
        aggregateDigest: sha("aggregate"),
        sourceCommit: source,
        sourceDigest,
        importDigest: sha("import"),
        backupDigest: sha("backup"),
        preimageDigest: sha("preimage"),
        classificationDigest: sha("classifications"),
        writerDigest: sha("writer"),
        writerEpoch,
        resumeDigest: sha("none"),
      }),
    ).toBeNull();
  });

  test("refuses pending phase review even with an exact binding digest", async () => {
    const f = fixture();
    const options = await loadMoneyUnitCutoverOptions(f.paths.declaration, target, f);
    const binding = {
      kind: "takoserver.money-review-binding@v1",
      phase: "freeze",
      accountId: account,
      databaseId,
      originDigest: sha("origin"),
      predecessorCustodyDigest: sha("previous"),
      sourceCommit: source,
      sourceDigest,
      importDigest: sha("import"),
      backupDigest: sha("backup"),
      preimageDigest: sha("preimage"),
      aggregateDigest: sha("aggregate"),
      classificationDigest: sha("classification"),
      writerDigest: sha("writer"),
      writerEpoch,
      resumeDigest: sha("none"),
    } as const;
    const evidenceDigest = sha("review-evidence");
    f.write(f.paths.review, {
      kind: "takoserver.money-independent-review@v1",
      state: "pending",
      reviewedAt: null,
      reviewEvidenceDigest: null,
      reviewer: "PENDING independent review",
      reviewRef: "pending:phase-review",
      bindingDigest: moneyCutoverBindingDigest(binding),
      evidenceDigest,
    });
    await expect(options.independentReview?.(binding)).rejects.toThrow("independent review");
    f.write(f.paths.review, {
      kind: "takoserver.money-independent-review@v1",
      state: "reviewed",
      reviewedAt,
      reviewEvidenceDigest: evidenceDigest,
      reviewer: "phase-reviewer",
      reviewRef: "review://phase-freeze",
      bindingDigest: moneyCutoverBindingDigest(binding),
      evidenceDigest,
    });
    expect(await options.independentReview?.(binding)).toMatchObject({
      state: "reviewed",
      bindingDigest: moneyCutoverBindingDigest(binding),
    });
  });
});
