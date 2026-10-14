import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectedWorkerSecrets } from "../scripts/deploy/realized-config.ts";
import { moneyCutoverBindingDigest } from "../scripts/deploy/schema-money-unit-cutover.ts";
import { loadMoneyUnitCutoverOptions } from "../scripts/deploy/schema-money-unit-owner.ts";
import type { DeployTarget } from "../scripts/deploy/target.ts";
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

const target: DeployTarget = {
  kind: "takoserver.deploy-target@v2",
  environment: "integration",
  accountId: account,
  workerName: "takoserver-api-integration",
  d1: { databaseName: name, databaseId },
  r2: { bucketName: name },
  publicOrigin: "https://takoserver-api-integration.test.workers.dev",
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
  let privateDigest = sha(nativeBytes);
  let extraPublicBinding = false;
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
                      : [{ name: binding, type: requirement.type, ...requirement.fields }],
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
    setPublicMode(value: boolean) {
      publicMode = value;
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

describe("money unit owner adapter", () => {
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
    expect(await options.resumeProof?.()).toMatchObject({
      sourceCommit: resumeSource,
      moduleDigest: sha(resumeBytes),
      nativeHealth: "healthy",
      oldMoneyWriters: 0,
    });
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
