import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  historicalResourceBindingsMatch,
  readAuth103HistoricalPublication,
} from "../scripts/deploy/auth103-historical-publication.ts";
import { assertExactOriginalModuleBytes } from "../scripts/deploy/auth103-original-worker-modules.ts";
import { DeployError } from "../scripts/deploy/errors.ts";
import { canonicalJson } from "../src/json.ts";

const sourceCommit = "a".repeat(40);
const targetDigest = "b".repeat(64);
const sourceRef = `sha256:${"c".repeat(64)}`;
const versionId = "11111111-1111-4111-8111-111111111111";
const deploymentId = "22222222-2222-4222-8222-222222222222";
const target = {
  workerName: "integration-auth103-historical-test",
  accountId: "account-test",
  d1: { databaseName: "database-test", databaseId: "database-id-test" },
  r2: { bucketName: "bucket-test" },
};
const targetRef = `sha256:${createHash("sha256")
  .update(
    canonicalJson([
      "takoserver.auth103.native-state-db.v1",
      target.accountId,
      target.d1.databaseId,
    ]),
  )
  .digest("hex")}`;
const digest = (value: Uint8Array | string) =>
  `sha256:${createHash("sha256").update(value).digest("hex")}`;
const files = [
  "BUILD.ts",
  "BUILD-RESULT-v5.json",
  "SEAM-PROBE-v2.ts",
  "SEAM-PROBE-RESULT-v2.json",
  "release/worker.js",
  "release/auth103-source-install.sql",
  "release/wrangler.jsonc",
] as const;

function fixture() {
  const custody = mkdtempSync(join(tmpdir(), "auth103-historical-publication-"));
  chmodSync(custody, 0o700);
  const proof = join(custody, "auth103-historical-publication");
  mkdirSync(proof, { mode: 0o700 });
  mkdirSync(join(proof, "release"), { mode: 0o700 });
  const worker = Buffer.from(
    `export const source = "${sourceRef}"; export const target = "${targetRef}";\n`,
  );
  const sql = Buffer.from(
    `SELECT '${sourceRef}', '${sourceRef}', '${sourceRef}', '${targetRef}', '${digest(worker)}', '${digest(worker)}', '${digest(worker)}', '${sourceCommit}', '${sourceCommit}';\n`,
  );
  const config = {
    name: target.workerName,
    main: "worker.js",
    account_id: target.accountId,
    d1_databases: [
      {
        binding: "STATE_DB",
        database_name: target.d1.databaseName,
        database_id: target.d1.databaseId,
      },
    ],
    r2_buckets: [{ binding: "OBJECTS", bucket_name: target.r2.bucketName }],
    vars: {
      TAKOSERVER_SOURCE_COMMIT: sourceCommit,
      TAKOSERVER_WORKER_ARTIFACT_DIGEST: digest(worker),
    },
    define: {
      __TAKOSERVER_AUTH103_NATIVE_SOURCE__: JSON.stringify({
        version: 1,
        sourceCommit,
        sourceRef,
        targetRef,
      }),
      __TAKOSERVER_AUTH103_NATIVE_PROFILE__: JSON.stringify("root-shared-auth-staging-v1"),
    },
  };
  const build = `const COMMIT = "${sourceCommit}";\nconst TARGET_DIGEST = "${targetDigest}";\nprepareWorkerArtifact({});\ncreateAuth103NativeSourceInstallContribution();\n`;
  const probe = `const commit = "${sourceCommit}";\nconst result = originalAuth103ModuleDigests(buildAuth103OriginalWorkerModules(target, commit));\nif (result.worker !== "${digest(worker).slice(7)}" || result.sql !== "${digest(sql).slice(7)}") throw new Error("mismatch");\n`;
  const record = {
    kind: "takoserver.auth103-historical-original-local-build@v1",
    status: "source-qualified",
    sourceCommit,
    targetDigest,
    releaseInventory: ["auth103-source-install.sql", "worker.js", "wrangler.jsonc"],
    bundleDigest: digest(worker),
    bundleBytes: worker.length,
    installSqlDigest: digest(sql),
    installSqlBytes: sql.length,
    installSqlRecomposedFromOriginal: true,
  };
  const proofRecord = {
    status: "source-qualified",
    originalBuilderMatchesIndependentLocalRelease: true,
  };
  const content = new Map<string, Uint8Array>([
    ["BUILD.ts", Buffer.from(build)],
    ["BUILD-RESULT-v5.json", Buffer.from(`${JSON.stringify(record, null, 2)}\n`)],
    ["SEAM-PROBE-v2.ts", Buffer.from(probe)],
    ["SEAM-PROBE-RESULT-v2.json", Buffer.from(`${JSON.stringify(proofRecord, null, 2)}\n`)],
    ["release/worker.js", worker],
    ["release/auth103-source-install.sql", sql],
    ["release/wrangler.jsonc", Buffer.from(`${JSON.stringify(config, null, 2)}\n`)],
  ]);
  for (const [name, bytes] of content) writeFileSync(join(proof, name), bytes, { mode: 0o600 });
  const index = {
    kind: "takoserver.auth103-historical-publication-index@v1",
    versionId,
    deploymentId,
    files: Object.fromEntries(
      files.map((name) => {
        const bytes = content.get(name);
        if (bytes === undefined) throw new Error("incomplete fixture");
        return [name, { bytes: bytes.length, digest: digest(bytes) }];
      }),
    ),
  };
  const indexPath = join(custody, "auth103-historical-publication.json");
  writeFileSync(indexPath, `${JSON.stringify(index, null, 2)}\n`, { mode: 0o600 });
  const input = {
    phase: "preflight" as const,
    target,
    targetDigest,
    sourceCommit,
    versionId,
    deploymentId,
  };
  return { custody, proof, indexPath, index, input, worker, sql, config };
}

function inCustody(run: (value: ReturnType<typeof fixture>) => void) {
  const previous = process.env.TAKOSERVER_AUTH103_INSTALL_CUSTODY_DIRECTORY;
  const value = fixture();
  process.env.TAKOSERVER_AUTH103_INSTALL_CUSTODY_DIRECTORY = value.custody;
  try {
    run(value);
  } finally {
    if (previous === undefined) delete process.env.TAKOSERVER_AUTH103_INSTALL_CUSTODY_DIRECTORY;
    else process.env.TAKOSERVER_AUTH103_INSTALL_CUSTODY_DIRECTORY = previous;
    rmSync(value.custody, { recursive: true, force: true });
  }
}

test("an exact historical two-module comparison detects moved replay bytes", () => {
  inCustody(({ worker, sql }) => {
    const version = {
      main_module: "worker.js",
      modules: [
        {
          name: "auth103-source-install.sql",
          content_type: "text/plain",
          content_base64: sql.toString("base64"),
        },
        {
          name: "worker.js",
          content_type: "application/javascript+module",
          content_base64: worker.toString("base64"),
        },
      ],
    };
    expect(
      assertExactOriginalModuleBytes(
        "preflight",
        version,
        { worker, sql },
        digest(worker).slice(7),
      ),
    ).toBe(digest(worker).slice(7));
    const movedReplay = Buffer.from(
      worker.toString().replace(sourceRef, `sha256:${"d".repeat(64)}`),
    );
    expect(() =>
      assertExactOriginalModuleBytes(
        "preflight",
        version,
        { worker: movedReplay, sql },
        digest(worker).slice(7),
      ),
    ).toThrow(DeployError);
  });
});

test("an unreviewed synthetic index refuses even for a nonmatching Version", () => {
  inCustody(({ input }) => {
    expect(() => readAuth103HistoricalPublication(input)).toThrow(DeployError);
    expect(() =>
      readAuth103HistoricalPublication({
        ...input,
        versionId: "33333333-3333-4333-8333-333333333333",
      }),
    ).toThrow(DeployError);
  });
});

test("absent historical index retains the ordinary original-builder selection", () => {
  inCustody(({ input, indexPath }) => {
    rmSync(indexPath);
    expect(readAuth103HistoricalPublication(input)).toBeNull();
  });
});

test("retained config resources mechanically match only exact selected D1 and R2 bindings", () => {
  const cases: Array<(value: ReturnType<typeof fixture>["config"]) => void> = [
    (value) => {
      value.d1_databases = [];
    },
    (value) => {
      const first = value.d1_databases.at(0);
      if (first === undefined) throw new Error("D1 fixture is incomplete");
      first.database_id = "foreign-database";
    },
    (value) => {
      value.d1_databases.push({
        binding: "OTHER_DB",
        database_name: target.d1.databaseName,
        database_id: target.d1.databaseId,
      });
    },
    (value) => {
      value.r2_buckets = [];
    },
    (value) => {
      const first = value.r2_buckets.at(0);
      if (first === undefined) throw new Error("R2 fixture is incomplete");
      first.bucket_name = "foreign-bucket";
    },
    (value) => {
      value.r2_buckets.push({ binding: "OTHER_BUCKET", bucket_name: target.r2.bucketName });
    },
  ];
  for (const mutate of cases) {
    inCustody(({ config }) => {
      expect(historicalResourceBindingsMatch(config, target)).toBe(true);
      mutate(config);
      expect(historicalResourceBindingsMatch(config, target)).toBe(false);
    });
  }
});

test("malformed present index refuses before fallback", () => {
  inCustody(({ input, indexPath }) => {
    writeFileSync(indexPath, "{}\n");
    expect(() => readAuth103HistoricalPublication(input)).toThrow(DeployError);
  });
});
