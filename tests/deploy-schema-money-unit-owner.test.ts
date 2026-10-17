import { Database } from "bun:sqlite";
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildD1MigrationImport } from "../scripts/deploy/d1-migration-import.ts";
import { normalizeSnapshotDump } from "../scripts/deploy/d1-snapshot-restore.ts";
import {
  type IntegrationStorageGenerationInvocation,
  runIntegrationStorageGeneration,
} from "../scripts/deploy/integration-storage-generation.ts";
import { canonicalSchemaShape, readMigrationArtifact } from "../scripts/deploy/migrations.ts";
import { type CommandResult, REPOSITORY } from "../scripts/deploy/process.ts";
import { removeArtifactTree, sealDirectory } from "../scripts/deploy/qualification.ts";
import { expectedWorkerSecrets } from "../scripts/deploy/realized-config.ts";
import {
  buildMoneyCutoverImportSql,
  type MoneyCutoverDispatchBinding,
  type MoneyPost94DispatchBinding,
  type MoneyReviewBinding,
  moneyCutoverBindingDigest,
  moneyUnitCutoverSourcePrefixDigest,
  readMoneyAggregateDigest,
  readMoneyFrozenDataDigest,
  readMoneyPreimageDigest,
  runIntegrationMoneyUnitCutover,
} from "../scripts/deploy/schema-money-unit-cutover.ts";
import {
  assertMoneyUnitOriginalWriterOptions,
  loadMoneyUnitCutoverOptions,
  loadMoneyUnitOriginalCutoverOptions,
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

function freshOriginalMoneyFixture() {
  const { cloudflareProviderExecutor: _managed, ...standalone } = target;
  const pair = `integration-ts-${generation}`;
  const selected: DeployTarget = {
    ...standalone,
    workerName: "integration-money-host",
    publicOrigin: "https://integration-money-host.test.workers.dev",
    d1: { databaseName: pair, databaseId },
    r2: { bucketName: pair },
    takoformV2: {
      storageLineage: "v2-0092",
      config: JSON.stringify({
        documentation: "https://docs.example.test",
        authenticationDocumentation: "https://auth.example.test",
      }),
    },
  };
  const f = fixture(selected);
  const originalTarget: DeployTarget = {
    kind: "takoserver.deploy-target@v2",
    environment: "integration",
    accountId: account,
    workerName: "old-incumbent",
    publicOrigin: "https://old-incumbent.test.workers.dev",
    d1: { databaseName: "old-incumbent", databaseId: id(900) },
    r2: { bucketName: "old-incumbent" },
    signing: { currentKeyId: "key-current" },
  };
  const originalTargetPath = join(f.root, "original-target.json");
  f.write(originalTargetPath, originalTarget);
  const originalDirectory = join(f.root, "original-custody");
  mkdirSync(originalDirectory, { mode: 0o700 });
  const pin = lstatSync(originalDirectory, { bigint: true });
  const originalCreate = {
    kind: "positive-fresh-0092" as const,
    custodyDirectory: originalDirectory,
    custodyIdentity: { device: String(pin.dev), inode: String(pin.ino) },
  };
  const invocation: IntegrationStorageGenerationInvocation = {
    action: "apply",
    environment: "integration",
    commit: source,
    generation,
    namespace: "integration-ts",
    freshLineage: "v2-0092",
  };
  const {
    originCertificatePath: _certificate,
    originCertificateDigest: _digest,
    privateSourceRoot: _privateSource,
    ...base
  } = f.declaration;
  const declaration = {
    ...base,
    databaseName: pair,
    bucketName: pair,
    privateWriterScopeDigest: f.write(f.paths.scope, {
      ...f.scope,
      profile: "standalone-host",
      publicSourceCommit: source,
      sourceInventoryDigest: sha(f.inventory),
      components: [],
    }),
    originalOrigin: { invocation, originalTargetPath },
  };
  f.write(f.paths.declaration, declaration);
  const request = {
    selectedTarget: selected,
    declarationPath: f.paths.declaration,
    originalCreate,
  };
  return {
    ...f,
    target: selected,
    declaration,
    request,
    invocation,
    originalTarget,
    originalTargetPath,
    originalDirectory,
    pair,
  };
}

/** Actual creator/verifier/HTTP adapter; HTTP and command protocols are local stand-ins, never native evidence. */
async function createdOriginalMoneyFixture(lostCreateAck = false) {
  const f = freshOriginalMoneyFixture();
  const database = new Database(":memory:");
  const contacts: string[] = [];
  const commands: string[][] = [];
  let createdD1 = false;
  let createdR2 = false;
  let returnedD1Id = databaseId;
  let returnedD1Name = f.pair;
  let imports = 0;
  let loseIdentityAfterImport = false;
  let retainedImportFailure: "mixed-mode" | "digest" | undefined;
  let retainedImport: { path: string; bytes: Uint8Array } | undefined;
  let retainedImportFaultApplied = false;
  let driftSealedInputAfterProviderAck = false;
  let importAckSealFaultApplied = false;
  const snapshot = () => {
    const quoteName = (name: string) => `"${name.replaceAll('"', '""')}"`;
    const tables = database
      .query(
        "SELECT name, sql FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all() as { name: string; sql: string }[];
    const statements = ["PRAGMA foreign_keys=OFF;", "BEGIN TRANSACTION;"];
    for (const table of tables) statements.push(`${table.sql};`);
    for (const table of tables) {
      const columns = database.query(`PRAGMA table_info(${quoteName(table.name)})`).all() as {
        name: string;
      }[];
      const projections = columns.map(
        (column, index) => `quote(${quoteName(column.name)}) AS v${index}`,
      );
      const rows = database
        .query(`SELECT ${projections.join(",")} FROM ${quoteName(table.name)}`)
        .all() as Record<string, string>[];
      for (const row of rows)
        statements.push(
          `INSERT INTO ${quoteName(table.name)} VALUES (${columns.map((_, index) => row[`v${index}`]).join(",")});`,
        );
    }
    for (const row of database
      .query(
        "SELECT sql FROM sqlite_schema WHERE type IN ('index','trigger','view') AND sql IS NOT NULL ORDER BY type, name",
      )
      .all() as { sql: string }[])
      statements.push(`${row.sql};`);
    statements.push("COMMIT;");
    return statements.join("\n");
  };
  const protocolFetch = Object.assign(
    async (input: Parameters<typeof globalThis.fetch>[0]) => {
      if (!(input instanceof Request)) throw new Error("unexpected non-Request protocol");
      const url = new URL(input.url);
      if (
        url.origin !== "https://api.cloudflare.com" ||
        !url.pathname.startsWith(`/client/v4/accounts/${account}/`)
      )
        throw new Error("unexpected protocol destination");
      contacts.push(`${input.method} ${url.pathname}`);
      const path = url.pathname.slice(`/client/v4/accounts/${account}`.length);
      let result: unknown;
      if (path === "/d1/database" && input.method === "POST") {
        expect(await input.json()).toEqual({ name: f.pair });
        createdD1 = true;
        if (lostCreateAck) throw new Error("controlled lost create ACK");
        result = { name: f.pair, uuid: databaseId };
      } else if (path === "/d1/database" && input.method === "GET") {
        expect(url.searchParams.get("name")).toBe(f.pair);
        result = createdD1 ? [{ name: f.pair, uuid: databaseId }] : [];
      } else if (path === `/d1/database/${databaseId}` && input.method === "GET") {
        if (!createdD1) throw new Error("D1 not created");
        result = { name: returnedD1Name, uuid: returnedD1Id };
      } else if (path === "/r2/buckets" && input.method === "POST") {
        expect(await input.json()).toEqual({ name: f.pair });
        createdR2 = true;
        result = { name: f.pair };
      } else if (path === "/r2/buckets" && input.method === "GET") {
        result = { buckets: createdR2 ? [{ name: f.pair }] : [] };
      } else if (path === `/r2/buckets/${f.pair}` && input.method === "GET") {
        if (!createdR2) throw new Error("R2 not created");
        result = { name: f.pair };
      } else throw new Error("unexpected provider protocol operation");
      return Response.json({ success: true, errors: [], messages: [], result });
    },
    {
      preconnect(..._parameters: Parameters<typeof globalThis.fetch.preconnect>): never {
        throw new Error("unexpected original money preconnect");
      },
    },
  ) satisfies typeof globalThis.fetch;
  const http = spyOn(globalThis, "fetch").mockImplementation(protocolFetch);
  const run: NonNullable<MoneyUnitOwnerDependencies["run"]> = async (command) => {
    commands.push([...command]);
    const key = command.join(" ");
    const ok = (stdout = ""): CommandResult => ({ exitCode: 0, stdout, stderr: "" });
    if (key === "git rev-parse HEAD") return ok(`${source}\n`);
    if (key === "git branch --show-current") return ok("component-original-money\n");
    if (key === "git status --porcelain=v1 -z --untracked-files=all") return ok();
    if (key === "bun run check:migrations") return ok("controlled source gate\n");
    if (key === "git fetch --quiet --all --prune") return ok();
    if (key === `git branch -r --contains ${source}`)
      return ok("origin/component-original-money\n");
    if (command.includes("d1") && command.includes("export")) {
      const path = command[command.indexOf("--output") + 1];
      if (!path) throw new Error("missing controlled export path");
      writeFileSync(path, snapshot(), { mode: 0o600 });
      return ok("controlled export\n");
    }
    if (command.includes("d1") && command.includes("execute")) {
      const file = command.indexOf("--file");
      if (file >= 0) {
        const path = command[file + 1];
        if (!path) throw new Error("missing controlled import path");
        database.exec(readFileSync(path, "utf8"));
        imports++;
        if (loseIdentityAfterImport && imports > 1) returnedD1Id = id(903);
        if (retainedImportFailure !== undefined && imports > 1) {
          retainedImport = { path, bytes: readFileSync(path) };
        }
        const acknowledgement = ok("controlled import ACK\n");
        if (driftSealedInputAfterProviderAck && imports > 1) {
          // The provider accepted the import; drift before runImport receives its success result.
          const retained = readFileSync(path);
          chmodSync(path, 0o600);
          writeFileSync(
            path,
            Buffer.concat([retained, Buffer.from("\n-- controlled acknowledged input drift\n")]),
          );
          chmodSync(path, 0o400);
          importAckSealFaultApplied = true;
        }
        return acknowledgement;
      }
      const query = command.indexOf("--command");
      const sql = command[query + 1];
      if (query < 0 || !sql || !/^(?:SELECT|PRAGMA)\b/u.test(sql))
        throw new Error("unexpected D1 protocol");
      if (
        retainedImportFailure !== undefined &&
        retainedImport !== undefined &&
        !retainedImportFaultApplied
      ) {
        // The import command already returned its ACK; fault the retained seal on post-read.
        chmodSync(retainedImport.path, 0o600);
        if (retainedImportFailure === "digest") {
          writeFileSync(
            retainedImport.path,
            Buffer.concat([
              retainedImport.bytes,
              Buffer.from("\n-- controlled retained import drift\n"),
            ]),
          );
          chmodSync(retainedImport.path, 0o400);
        }
        retainedImportFaultApplied = true;
      }
      return ok(JSON.stringify([{ success: true, results: database.query(sql).all() }]));
    }
    return f.run(command);
  };
  const dependencies = {
    ...f,
    run,
    cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "controlled-original-money-token" },
    storage: {
      async getD1() {
        return { name: f.pair, uuid: databaseId };
      },
      async getR2() {
        return { name: f.pair };
      },
    },
  };
  const create = () =>
    runIntegrationStorageGeneration(f.invocation, f.originalTarget, {
      originalCreate: f.request.originalCreate,
      run,
      cloudflareEnvironment: dependencies.cloudflareEnvironment,
      review: "controlled-original-protocol-review",
    });
  try {
    if (!lostCreateAck) await create();
  } catch (error) {
    http.mockRestore();
    database.close();
    throw error;
  }
  return {
    ...f,
    database,
    contacts,
    commands,
    dependencies,
    create,
    load: () => loadMoneyUnitOriginalCutoverOptions(f.request, dependencies),
    replaceNativeD1(id: string, name = f.pair) {
      returnedD1Id = id;
      returnedD1Name = name;
    },
    failPostImportIdentity() {
      loseIdentityAfterImport = true;
    },
    failRetainedImportAfterAck(kind: "mixed-mode" | "digest") {
      retainedImportFailure = kind;
    },
    retainedImportFaultApplied: () => retainedImportFaultApplied,
    failImportSealAfterProviderAck() {
      driftSealedInputAfterProviderAck = true;
    },
    importAckSealFaultApplied: () => importAckSealFaultApplied,
    imports: () => imports,
    close() {
      http.mockRestore();
      database.close();
    },
  };
}

// All positives below are component protocol fixtures, not native creation/cutover qualification.
describe("fresh original money writer", () => {
  test("fresh writer keeps default/read parser semantics and requires its exact source selector", () => {
    const f = freshOriginalMoneyFixture();
    expect(() => parseDeployTarget(f.target, "component", "integration")).toThrow("writer policy");
    expect(
      parseDeployTarget(f.target, "component", "integration", "money-resume-read"),
    ).toMatchObject({ d1: { databaseName: f.pair } });
    expect(
      parseDeployTarget(f.target, "component", "integration", "money-original-cutover"),
    ).toMatchObject({ d1: { databaseName: f.pair } });
    for (const selected of [
      target,
      { ...f.target, environment: "production" as const },
      { ...f.target, workerName: "host-integration" },
      { ...f.target, r2: { bucketName: name } },
      { ...f.target, moneyCutoverWriterEpoch: undefined },
    ]) {
      expect(() =>
        parseDeployTarget(selected, "component", "integration", "money-original-cutover"),
      ).toThrow();
    }
  });

  test("fresh writer refuses missing original locators, legacy certificates and JSON proofs before native reads", async () => {
    const f = freshOriginalMoneyFixture();
    await expect(loadMoneyUnitCutoverOptions(f.paths.declaration, f.target, f)).rejects.toThrow(
      "legacy staging origin",
    );
    const { originalOrigin: _locators, ...withoutOriginal } = f.declaration;
    f.write(f.paths.declaration, {
      ...withoutOriginal,
      originCertificatePath: f.paths.origin,
      originCertificateDigest: sha(JSON.stringify(f.origin)),
    });
    await expect(loadMoneyUnitOriginalCutoverOptions(f.request, f)).rejects.toThrow("declaration");
    f.write(f.paths.declaration, f.declaration);
    const forged = { ...f.request, originalCreate: { ...f.request.originalCreate, ready: true } };
    await expect(loadMoneyUnitOriginalCutoverOptions(forged, f)).rejects.toThrow();
    const forgedProof = {
      ...f.request,
      nativeProof: { authority: "provider-native", state: "terminal" },
    };
    await expect(loadMoneyUnitOriginalCutoverOptions(forgedProof, f)).rejects.toThrow(
      "only target",
    );
    expect(f.requests).toEqual([]);
  });

  test("fresh writer bounds and fatally decodes its held declaration before native reads", async () => {
    const f = freshOriginalMoneyFixture();
    for (const bytes of [new Uint8Array([0xff]), new Uint8Array(1024 * 1024 + 1)]) {
      writeFileSync(f.paths.declaration, bytes);
      await expect(loadMoneyUnitOriginalCutoverOptions(f.request, f)).rejects.toThrow();
    }
    f.write(f.paths.declaration, f.declaration);
    chmodSync(f.paths.declaration, 0o644);
    await expect(loadMoneyUnitOriginalCutoverOptions(f.request, f)).rejects.toThrow("0600");
    expect(f.requests).toEqual([]);
  });

  test("fresh writer uses the actual original chain after current schema advances through 93 and 94", async () => {
    const f = await createdOriginalMoneyFixture();
    try {
      const options = await f.load();
      expect(options.originalOriginQualification).toBe("independent-origin-review-required");
      expect(Object.isFrozen(options)).toBe(true);
      expect(Object.isFrozen(options.custody)).toBe(true);
      expect(() => assertMoneyUnitOriginalWriterOptions(options, f.target)).not.toThrow();
      const origin = await options.stageOriginProof();
      expect(origin).toMatchObject({
        databaseName: f.pair,
        databaseId,
        sourceCommit: source,
        sourceDigest,
        state: "terminal",
      });
      const queries = f.commands.filter((c) => c.includes("--command")).length;
      const files = readMigrationArtifact(join(REPOSITORY, "migrations")).files;
      for (const index of [92, 93]) {
        const file = files[index];
        if (!file) throw new Error("missing audited current phase source");
        f.database.exec(readFileSync(file.path, "utf8"));
        expect(await options.stageOriginProof()).toEqual(origin);
      }
      expect(f.commands.filter((c) => c.includes("--command")).length).toBe(queries);
      expect(await options.storageIdentityRead()).toEqual({
        accountId: account,
        databaseId,
        databaseName: f.pair,
        bucketName: f.pair,
      });
      const binding: MoneyReviewBinding = {
        kind: "takoserver.money-review-binding@v1",
        phase: "freeze",
        accountId: account,
        databaseId,
        originDigest: sha(JSON.stringify(origin)),
        predecessorCustodyDigest: origin.terminalCustodyDigest,
        sourceCommit: source,
        sourceDigest,
        importDigest: sha("component sealed import"),
        backupDigest: sha("component backup"),
        preimageDigest: sha("component preimage"),
        aggregateDigest: sha("component aggregates"),
        classificationDigest: sha("component classification"),
        writerDigest: sha("component exact writer"),
        resumeDigest: sha("none"),
        writerEpoch,
      };
      expect(await options.independentReview?.(binding)).toBeNull();
      expect((await options.maintenanceProof()).privateMoneyWriters).toBe(0);
    } finally {
      f.close();
    }
  });

  test("fresh writer rejects copied options, forged proof ports and a different current target", async () => {
    const f = await createdOriginalMoneyFixture();
    try {
      const options = await f.load();
      const invocation = {
        action: "status" as const,
        environment: "integration" as const,
        commit: source,
        throughMigration: "0093" as const,
      };
      for (const copied of [
        { ...options },
        {
          ...options,
          stageOriginProof: async () => ({
            ...(await options.stageOriginProof()),
            state: "terminal" as const,
          }),
        },
      ]) {
        await expect(runIntegrationMoneyUnitCutover(invocation, f.target, copied)).rejects.toThrow(
          "same owning original options",
        );
      }
      await expect(
        runIntegrationMoneyUnitCutover(
          { ...invocation, throughMigration: "0094" },
          f.target,
          options,
        ),
      ).rejects.toThrow("phase and fixed schema wave differ");
      expect(() =>
        assertMoneyUnitOriginalWriterOptions(options, {
          ...f.target,
          d1: { ...f.target.d1, databaseId: id(901) },
        }),
      ).toThrow("same owning original options");
      expect(() =>
        Object.defineProperty(options, "stageOriginProof", {
          value: async () => ({ ready: true }),
        }),
      ).toThrow();
      expect(() =>
        Object.defineProperty(options.custody, "dispatch", {
          value: async () => ({ ready: true }),
        }),
      ).toThrow();
    } finally {
      f.close();
    }
  });

  test("fresh writer captures original dependency ports and refuses replaced selected inputs", async () => {
    const f = await createdOriginalMoneyFixture();
    try {
      const options = await f.load();
      f.dependencies.storage.getD1 = async () => {
        throw new Error("late storage replacement consumed");
      };
      f.dependencies.state.workerDeployments = async () => {
        throw new Error("late state replacement consumed");
      };
      expect(await options.storageIdentityRead()).toMatchObject({ databaseName: f.pair });
      expect((await options.maintenanceProof()).privateMoneyWriters).toBe(0);
      const contacts = f.contacts.length;
      f.write(f.originalTargetPath, { ...f.originalTarget, workerName: "changed-incumbent" });
      await expect(options.stageOriginProof()).rejects.toThrow("changed after selection");
      expect(f.contacts.length).toBe(contacts);
    } finally {
      f.close();
    }
  });

  test("fresh writer retains UNKNOWN and classifies post-import identity loss as verification", async () => {
    const f = await createdOriginalMoneyFixture(true);
    try {
      await expect(f.create()).rejects.toThrow();
      const paths = readdirSync(f.originalDirectory).filter((p) => p.endsWith(".json"));
      const before = paths.map((p) => readFileSync(join(f.originalDirectory, p), "utf8"));
      const contacts = f.contacts.length;
      await expect(f.load()).rejects.toThrow("terminal chain");
      expect(f.contacts.length).toBe(contacts);
      expect(paths.map((p) => readFileSync(join(f.originalDirectory, p), "utf8"))).toEqual(before);
      expect(
        f.contacts.filter((p) => p === `POST /client/v4/accounts/${account}/d1/database`),
      ).toHaveLength(1);
    } finally {
      f.close();
    }
    const mismatch = await createdOriginalMoneyFixture();
    try {
      mismatch.replaceNativeD1(id(902));
      await expect(mismatch.load()).rejects.toThrow("ACK");
    } finally {
      mismatch.close();
    }
    const post = await createdOriginalMoneyFixture();
    try {
      const options = await post.load();
      const invocation = {
        action: "status" as const,
        environment: "integration" as const,
        commit: source,
        throughMigration: "0093" as const,
      };
      const status = await runIntegrationMoneyUnitCutover(invocation, post.target, options);
      if (typeof status.reviewBindingDigest !== "string")
        throw new Error("missing actual review binding");
      const evidenceDigest = sha("controlled post-import phase review");
      post.write(post.paths.review, {
        kind: "takoserver.money-independent-review@v1",
        state: "reviewed",
        reviewedAt,
        reviewEvidenceDigest: evidenceDigest,
        reviewer: "component-reviewer",
        reviewRef: "review://controlled-post-import",
        bindingDigest: status.reviewBindingDigest,
        evidenceDigest,
      });
      post.failPostImportIdentity();
      try {
        await runIntegrationMoneyUnitCutover(
          { ...invocation, action: "apply" },
          post.target,
          options,
        );
        throw new Error("expected controlled post-import failure");
      } catch (error) {
        expect(error).toMatchObject({ phase: "verification" });
        if (!(error instanceof Error)) throw error;
        expect(error.message).toContain("after import");
        expect(error.cause).toBeInstanceOf(Error);
      }
      expect(post.imports()).toBe(2); // Original92 plus exactly one actual money freeze import.
      expect(await options.custody.read("freeze")).toMatchObject({ state: "dispatched" });
      await expect(
        runIntegrationMoneyUnitCutover({ ...invocation, action: "apply" }, post.target, options),
      ).rejects.toThrow("cannot resend");
      expect(post.imports()).toBe(2);
      expect(await options.custody.read("freeze")).toMatchObject({ state: "dispatched" });
    } finally {
      post.close();
    }
  });

  test("fresh money CLI keeps original selection closed before provider or production input reads", () => {
    const result = Bun.spawnSync(
      [
        process.execPath,
        "--no-env-file",
        "scripts/deploy.ts",
        "takoserver-d1-schema",
        "--status",
        "--environment=integration",
        `--commit=${source}`,
        "--through-migration=0088",
      ],
      {
        cwd: REPOSITORY,
        env: {
          PATH: "/usr/local/bin:/usr/bin:/bin",
          TMPDIR: tmpdir(),
          TAKOSERVER_INTEGRATION_STORAGE_ORIGINAL_CREATE_INPUT_PATH: "/not-a-selected-input",
          TAKOSERVER_DEPLOY_TARGET_PRODUCTION: "/must-not-read-production",
        },
        timeout: 1000,
      },
    );
    expect(result.exitCode).not.toBe(0);
    expect(new TextDecoder().decode(result.stderr)).toContain(
      "original-create input is supported only",
    );
  });
});

function sealedImportCustodyFixture() {
  const f = fixture();
  const directory = join(f.root, "sealed-money-import");
  mkdirSync(directory, { mode: 0o700 });
  const sealedImportPath = join(directory, "import.sql");
  const sql = "-- component custody bytes; never executed\n";
  writeFileSync(sealedImportPath, sql, { mode: 0o600 });
  const binding: MoneyCutoverDispatchBinding = {
    kind: "takoserver.money-cutover-dispatch@v1",
    phase: "freeze",
    accountId: account,
    databaseId,
    databaseName: name,
    originDigest: sha("origin"),
    predecessorCustodyDigest: sha("previous"),
    sourceCommit: source,
    sourceDigest,
    importDigest: sha(sql),
    backupDigest: sha("backup"),
    preimageDigest: sha("preimage"),
    aggregateDigest: sha("aggregate"),
    classificationDigest: sha("classifications"),
    writerDigest: sha("writer"),
    resumeDigest: sha("none"),
    writerEpoch,
    reviewDigest: sha("review"),
    beforeShapeDigest: sha("shape"),
    afterSchemaPhase: "0092-fenced",
    sealedImportPath,
  };
  return { ...f, directory, sealedImportPath, sql, binding };
}

describe("money sealed import custody", () => {
  test("reads the real readonly producer seal through dispatch, reopen and terminal custody", async () => {
    const f = sealedImportCustodyFixture();
    try {
      const seal = sealDirectory(f.directory, ["import.sql"]);
      expect(lstatSync(f.directory).mode & 0o777).toBe(0o500);
      expect(lstatSync(f.sealedImportPath).mode & 0o777).toBe(0o400);
      const options = await loadMoneyUnitCutoverOptions(f.paths.declaration, target, f);
      expect((await options.custody.dispatch(f.binding)).state).toBe("dispatched");
      expect(await options.custody.readDispatch("freeze")).toEqual(f.binding);
      expect(await options.custody.read("freeze")).toMatchObject({ state: "dispatched" });
      const reopened = await loadMoneyUnitCutoverOptions(f.paths.declaration, target, f);
      expect(await reopened.custody.readDispatch("freeze")).toEqual(f.binding);
      expect((await reopened.custody.terminal(f.binding, sha("post"))).state).toBe("terminal");
      expect(await reopened.custody.read("freeze")).toMatchObject({ state: "terminal" });
      expect(() => seal.assertUnchanged()).not.toThrow();
      expect(lstatSync(f.directory).mode & 0o777).toBe(0o500);
      expect(lstatSync(f.sealedImportPath).mode & 0o777).toBe(0o400);
      await expect(reopened.custody.dispatch(f.binding)).rejects.toThrow("already exists");
    } finally {
      removeArtifactTree(f.directory);
    }
  });

  test("refuses mixed or exposed import modes, links, oversize bytes and digest drift before custody writes", async () => {
    const f = sealedImportCustodyFixture();
    const options = await loadMoneyUnitCutoverOptions(f.paths.declaration, target, f);
    const directories: string[] = [];
    let ordinal = 0;
    const input = (directoryMode = 0o500, fileMode = 0o400, bytes = f.sql) => {
      const directory = join(f.root, `invalid-import-${ordinal++}`);
      directories.push(directory);
      mkdirSync(directory, { mode: 0o700 });
      const path = join(directory, "import.sql");
      writeFileSync(path, bytes, { mode: 0o600 });
      chmodSync(path, fileMode);
      chmodSync(directory, directoryMode);
      return {
        directory,
        path,
        binding: { ...f.binding, sealedImportPath: path, importDigest: sha(bytes) },
      };
    };
    const refused = async (binding: MoneyCutoverDispatchBinding) => {
      await expect(options.custody.dispatch(binding)).rejects.toThrow();
      expect(await options.custody.read("freeze")).toBeNull();
      expect(await options.custody.readDispatch("freeze")).toBeNull();
    };
    try {
      // Legacy 0700/0600 is deliberately still valid, as the unchanged old19 prove.
      for (const [directoryMode, fileMode] of [
        [0o500, 0o600],
        [0o700, 0o400],
        [0o755, 0o400],
        [0o500, 0o440],
        [0o700, 0o660],
        [0o500, 0o200],
      ])
        await refused(input(directoryMode, fileMode).binding);
      const linked = input(0o700, 0o600);
      rmSync(linked.path);
      symlinkSync(f.sealedImportPath, linked.path);
      await refused(linked.binding);
      const hard = input(0o700, 0o600);
      rmSync(hard.path);
      linkSync(f.sealedImportPath, hard.path);
      await refused(hard.binding);
      const nested = input(0o700, 0o600);
      const alias = join(f.root, "import-directory-alias");
      symlinkSync(nested.directory, alias);
      await refused({ ...nested.binding, sealedImportPath: join(alias, "import.sql") });
      await refused(input(0o500, 0o400, "x".repeat(1024 * 1024 + 1)).binding);
      const drift = input();
      await expect(
        options.custody.dispatch({ ...drift.binding, importDigest: sha("other bytes") }),
      ).rejects.toThrow("sealed import SQL differs before dispatch");
      expect(await options.custody.read("freeze")).toBeNull();
      await refused({ ...f.binding, sealedImportPath: join(REPOSITORY, "package.json") });
    } finally {
      for (const directory of directories) removeArtifactTree(directory);
      removeArtifactTree(f.directory);
    }
  });
});

describe("money acknowledged custody failure", () => {
  test("classifies retained seal drift after an import ACK as verification and never replays", async () => {
    for (const fault of ["mixed-mode", "digest"] as const) {
      const post = await createdOriginalMoneyFixture();
      try {
        const options = await post.load();
        const invocation = {
          action: "status" as const,
          environment: "integration" as const,
          commit: source,
          throughMigration: "0093" as const,
        };
        const status = await runIntegrationMoneyUnitCutover(invocation, post.target, options);
        if (typeof status.reviewBindingDigest !== "string")
          throw new Error("missing actual review binding");
        const evidenceDigest = sha(`controlled retained-seal phase review ${fault}`);
        post.write(post.paths.review, {
          kind: "takoserver.money-independent-review@v1",
          state: "reviewed",
          reviewedAt,
          reviewEvidenceDigest: evidenceDigest,
          reviewer: "component-reviewer",
          reviewRef: "review://controlled-retained-seal",
          bindingDigest: status.reviewBindingDigest,
          evidenceDigest,
        });
        post.failRetainedImportAfterAck(fault);
        try {
          await runIntegrationMoneyUnitCutover(
            { ...invocation, action: "apply" },
            post.target,
            options,
          );
          throw new Error("expected controlled post-ACK custody verification failure");
        } catch (error) {
          expect(error).toMatchObject({ phase: "verification" });
          if (!(error instanceof Error) || !(error.cause instanceof Error)) throw error;
          expect(error.message).toContain("acknowledged");
          expect(error.cause).toMatchObject({ phase: "preflight" });
          expect(error.cause.message).toContain("money sealed import SQL");
          if (fault === "digest")
            expect(error.cause.message).toContain("differs from immutable dispatch");
        }
        expect(post.retainedImportFaultApplied()).toBe(true);
        expect(post.imports()).toBe(2);
        const dispatched = join(post.declaration.custodyDirectory, "freeze.dispatched.json");
        const retained = readFileSync(dispatched, "utf8");
        const retainedDigest = sha(retained);
        expect(JSON.parse(retained)).toMatchObject({ receipt: { state: "dispatched" } });
        expect(existsSync(join(post.declaration.custodyDirectory, "freeze.terminal.json"))).toBe(
          false,
        );
        await expect(options.custody.readDispatch("freeze")).rejects.toThrow(
          "money sealed import SQL",
        );
        await expect(
          runIntegrationMoneyUnitCutover({ ...invocation, action: "apply" }, post.target, options),
        ).rejects.toThrow("money sealed import SQL");
        expect(post.imports()).toBe(2);
        expect(readFileSync(dispatched, "utf8")).toBe(retained);
        expect(sha(readFileSync(dispatched, "utf8"))).toBe(retainedDigest);
        expect(existsSync(join(post.declaration.custodyDirectory, "freeze.terminal.json"))).toBe(
          false,
        );
      } finally {
        post.close();
      }
    }
  });
});

describe("money acknowledged import input failure", () => {
  test("classifies input drift before an acknowledged import returns as verification without replay", async () => {
    const post = await createdOriginalMoneyFixture();
    try {
      const options = await post.load();
      const invocation = {
        action: "status" as const,
        environment: "integration" as const,
        commit: source,
        throughMigration: "0093" as const,
      };
      const status = await runIntegrationMoneyUnitCutover(invocation, post.target, options);
      if (typeof status.reviewBindingDigest !== "string")
        throw new Error("missing actual review binding");
      const evidenceDigest = sha("controlled acknowledged-input phase review");
      post.write(post.paths.review, {
        kind: "takoserver.money-independent-review@v1",
        state: "reviewed",
        reviewedAt,
        reviewEvidenceDigest: evidenceDigest,
        reviewer: "component-reviewer",
        reviewRef: "review://controlled-acknowledged-input",
        bindingDigest: status.reviewBindingDigest,
        evidenceDigest,
      });
      post.failImportSealAfterProviderAck();
      try {
        await runIntegrationMoneyUnitCutover(
          { ...invocation, action: "apply" },
          post.target,
          options,
        );
        throw new Error("expected acknowledged import input verification failure");
      } catch (error) {
        expect(error).toMatchObject({ phase: "verification" });
        if (!(error instanceof Error) || !(error.cause instanceof Error)) throw error;
        expect(error.message).toContain("acknowledged");
        expect(error.message).toContain("without replay");
        expect(error.cause).toMatchObject({ phase: "preflight" });
        expect(error.cause.message).toContain("artifact changed after it was sealed");
      }
      expect(post.importAckSealFaultApplied()).toBe(true);
      expect(post.imports()).toBe(2);
      const dispatched = join(post.declaration.custodyDirectory, "freeze.dispatched.json");
      const retained = readFileSync(dispatched, "utf8");
      const retainedDigest = sha(retained);
      expect(JSON.parse(retained)).toMatchObject({ receipt: { state: "dispatched" } });
      expect(existsSync(join(post.declaration.custodyDirectory, "freeze.terminal.json"))).toBe(
        false,
      );
      await expect(options.custody.readDispatch("freeze")).rejects.toThrow(
        "differs from immutable dispatch",
      );
      await expect(
        runIntegrationMoneyUnitCutover({ ...invocation, action: "apply" }, post.target, options),
      ).rejects.toThrow("differs from immutable dispatch");
      expect(post.imports()).toBe(2);
      expect(readFileSync(dispatched, "utf8")).toBe(retained);
      expect(sha(readFileSync(dispatched, "utf8"))).toBe(retainedDigest);
      expect(existsSync(join(post.declaration.custodyDirectory, "freeze.terminal.json"))).toBe(
        false,
      );
    } finally {
      post.close();
    }
  });
});

function post94CustodyFixture() {
  const f = sealedImportCustodyFixture();
  // Structural review data only; no protected declaration or held selection is minted.
  const selectionReview = {
    kind: "takoserver.money-post94-selection-review@v1" as const,
    phase: "suffix98" as const,
    accountId: f.binding.accountId,
    databaseId: f.binding.databaseId,
    databaseName: f.binding.databaseName,
    previousWriterEpoch: writerEpoch,
    nextWriterEpoch: sha("next retained writer epoch"),
    original92BackupDigest: f.binding.backupDigest,
    converted94BackupDigest: sha("converted full94 snapshot"),
    convertBindingDigest: sha("original terminal convert binding"),
    selectedStripeMode: "test" as const,
    declarationDigest: sha("component-only suffix selection declaration; never native custody"),
  };
  const binding: MoneyPost94DispatchBinding = {
    ...f.binding,
    kind: "takoserver.money-cutover-dispatch@v2",
    phase: "suffix98",
    previousWriterEpoch: writerEpoch,
    nextWriterEpoch: sha("next retained writer epoch"),
    original92BackupDigest: f.binding.backupDigest,
    converted94BackupDigest: sha("converted full94 snapshot"),
    convertBindingDigest: sha("original terminal convert binding"),
    modePreparationDigest: sha("structural fixture, never real Financial mode authority"),
    selectedStripeMode: selectionReview.selectedStripeMode,
    selectionReviewDigest: moneyCutoverBindingDigest(selectionReview),
    afterSchemaPhase: "0098-fenced",
    writerEpoch,
  };
  return { ...f, binding };
}

describe("post94 retained custody component", () => {
  test("post94 holds exact v2 dispatch through the existing readonly seal without authorizing apply", async () => {
    const f = post94CustodyFixture();
    try {
      const seal = sealDirectory(f.directory, ["import.sql"]);
      const options = await loadMoneyUnitCutoverOptions(f.paths.declaration, target, f);
      expect((await options.custody.dispatch(f.binding)).state).toBe("dispatched");
      const reopened = await loadMoneyUnitCutoverOptions(f.paths.declaration, target, f);
      expect(await reopened.custody.readDispatch("suffix98")).toEqual(f.binding);
      expect(await reopened.custody.read("suffix98")).toMatchObject({ state: "dispatched" });
      await expect(reopened.custody.dispatch(f.binding)).rejects.toThrow("already exists");
      const before = [...f.requests];
      await expect(
        runIntegrationMoneyUnitCutover(
          { action: "apply", environment: "integration", commit: source, throughMigration: "0098" },
          target,
          { ...options, phase: "suffix98" },
        ),
      ).rejects.toThrow("Financial realm transition port");
      expect(f.requests).toEqual(before);
      expect(await reopened.custody.read("suffix98")).toMatchObject({ state: "dispatched" });
      expect(() => seal.assertUnchanged()).not.toThrow();
      expect(lstatSync(f.directory).mode & 0o777).toBe(0o500);
      expect(lstatSync(f.sealedImportPath).mode & 0o777).toBe(0o400);
    } finally {
      removeArtifactTree(f.directory);
    }
  });

  test("post94 v2 parser refuses legacy promotion, missing history, equal epochs and field drift", async () => {
    const mutations = [
      { kind: "takoserver.money-cutover-dispatch@v1" },
      { phase: "freeze" },
      { previousWriterEpoch: sha("invalid selection") },
      { nextWriterEpoch: writerEpoch },
      { original92BackupDigest: sha("wrong old backup") },
      { converted94BackupDigest: null },
      { convertBindingDigest: "not-a-digest" },
      { modePreparationDigest: null },
      { afterSchemaPhase: "0098" },
      { extra: true },
    ];
    for (const mutation of mutations) {
      const f = post94CustodyFixture();
      try {
        sealDirectory(f.directory, ["import.sql"]);
        const options = await loadMoneyUnitCutoverOptions(f.paths.declaration, target, f);
        const binding = { ...f.binding, ...mutation };
        // Raw retained record tests the real protected parser, without a type escape or writer.
        writeFileSync(
          join(f.root, "suffix98.dispatched.json"),
          JSON.stringify({
            kind: "takoserver.money-cutover-dispatch-record@v1",
            receipt: {
              kind: "takoserver.money-cutover-custody@v1",
              phase: "suffix98",
              state: "dispatched",
              bindingDigest: sha(JSON.stringify(binding)),
              postDigest: null,
            },
            binding,
          }),
          { mode: 0o600 },
        );
        await expect(options.custody.readDispatch("suffix98")).rejects.toThrow("malformed");
        expect(existsSync(join(f.root, "suffix98.terminal.json"))).toBe(false);
      } finally {
        removeArtifactTree(f.directory);
      }
    }
  });

  test("post94 owner declaration cannot turn a retained v2 record into a native writer selection", async () => {
    const f = post94CustodyFixture();
    try {
      f.write(f.paths.declaration, {
        ...f.declaration,
        phase: "suffix98",
        nextWriterEpoch: f.binding.nextWriterEpoch,
      });
      const before = [...f.requests];
      await expect(loadMoneyUnitCutoverOptions(f.paths.declaration, target, f)).rejects.toThrow(
        "declaration is malformed",
      );
      expect(f.requests).toEqual(before);
      expect(existsSync(join(f.root, "suffix98.dispatched.json"))).toBe(false);
    } finally {
      removeArtifactTree(f.directory);
    }
  });
});
