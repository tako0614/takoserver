import { DEPLOY_CONTRACT } from "./deploy/contract.ts";
import { DeployError, type DeployPhase, PHASE_EXIT_CODE } from "./deploy/errors.ts";
import { appendLedger, EVIDENCE_LEDGER } from "./deploy/evidence.ts";
import { mutate } from "./deploy/mutate.ts";
import { inspectLive, preflight } from "./deploy/preflight.ts";
import { writeRealizedConfig } from "./deploy/realized-config.ts";
import { loadTarget, targetPath } from "./deploy/target.ts";
import { verify } from "./deploy/verify.ts";

const USAGE = `takoserver deploy

  bun run deploy -- --contract          print the deploy contract; touches nothing
  bun run deploy -- --status            read-only inspection of the realized target
  bun run deploy -- --plan              run every pre-mutation proof, publish nothing
  bun run deploy -- --apply             publish, then verify on the published origin

  --target <path>                       deploy target descriptor
                                        (default .deploy/target.json, or
                                        TAKOSERVER_DEPLOY_TARGET)

Exit codes: 2 nothing was touched, 3 the target may have been mutated and the
state is indeterminate, 4 bytes are published but post-conditions failed.
`;

const AFTERMATH: Readonly<Record<DeployPhase, string>> = {
  preflight: "No Cloudflare target was touched. Fix the cause and re-run.",
  mutation:
    "The target may have been mutated and its state is indeterminate. Do not re-run --apply " +
    "yet: run `bun run deploy -- --status` for an authoritative readback first.",
  verification:
    "Bytes are published but the post-conditions failed. Run `bun run deploy -- --status`, then " +
    "either repair forward or roll the Worker back to the previous version printed above. D1 " +
    "repair is forward-only; do not erase R2 objects or D1 rows to undo a code change.",
};

interface Mode {
  readonly action: "status" | "plan" | "apply";
  readonly targetPath: string;
}

function parseMode(args: readonly string[]): Mode | null {
  let action: Mode["action"] | null = null;
  let explicitTarget: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--status" || argument === "--plan" || argument === "--apply") {
      if (action !== null) return null;
      action = argument.slice(2) as Mode["action"];
      continue;
    }
    if (argument === "--target") {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) return null;
      explicitTarget = value;
      index += 1;
      continue;
    }
    return null;
  }
  if (action === null) return null;
  return { action, targetPath: targetPath(explicitTarget) };
}

function reversalNotice(previousVersionId: string | null, workerName: string): string {
  if (previousVersionId === null) {
    return (
      "reversal: this is the first published version of this Worker, so there is no earlier " +
      "version to return to. Forward repair is the only path; the Worker can be withdrawn with " +
      `\`wrangler delete --name ${workerName}\`, which does not erase D1 or R2 state.`
    );
  }
  return (
    "reversal: restore the previous version with `wrangler versions deploy " +
    `${previousVersionId}@100% --yes --config .wrangler-realized.jsonc\`. D1 repair is ` +
    "forward-only and is not part of this rollback."
  );
}

async function run(mode: Mode): Promise<void> {
  const target = loadTarget(mode.targetPath);

  if (mode.action === "status") {
    const configPath = writeRealizedConfig(target);
    const live = await inspectLive(configPath, target);
    process.stdout.write(
      `${JSON.stringify(
        {
          account: target.accountId,
          worker: target.workerName,
          publicOrigin: target.publicOrigin,
          servedVersionId: live.servedVersionId,
          appliedMigrations: live.appliedMigrations,
          runtimeTables: live.tables.filter((name) => name.startsWith("runtime_")),
          activeGrantKeyIds: live.activeGrantKeyIds,
        },
        null,
        2,
      )}\n`,
    );
    return;
  }

  const report = await preflight(target, { runGate: true });
  const previousVersionId = report.live.servedVersionId;

  process.stdout.write(
    `${JSON.stringify(
      {
        commit: report.commit,
        branch: report.branch,
        bundleDigest: report.bundleDigest,
        bundleBytes: report.bundleBytes,
        migrationDigest: report.migrationDigest,
        pendingMigrations: report.migrationFiles.filter(
          (name) => !report.live.appliedMigrations.includes(name),
        ),
        account: target.accountId,
        worker: target.workerName,
        previousVersionId,
        alreadyCurrent: report.alreadyCurrent,
      },
      null,
      2,
    )}\n`,
  );

  if (mode.action === "plan") {
    process.stdout.write("\nplan only: every pre-mutation proof passed; nothing was published\n");
    return;
  }

  if (report.alreadyCurrent && previousVersionId !== null) {
    process.stdout.write(
      `\nalready current: version ${previousVersionId} already serves this bundle digest; ` +
        "nothing was published\n",
    );
    return;
  }

  const result = await mutate(report);
  process.stdout.write(`\npublished version ${result.versionId}\n`);
  if (result.grantKeyProvisioned) {
    process.stdout.write(`provisioned verification key ${target.grantKeyId}\n`);
  }
  process.stdout.write(`${reversalNotice(previousVersionId, target.workerName)}\n`);

  const postConditions = await verify(report, result.versionId);
  for (const proven of postConditions) process.stdout.write(`verified: ${proven}\n`);

  appendLedger({
    publishedAt: new Date().toISOString(),
    commit: report.commit,
    branch: report.branch,
    remoteUrl: report.remoteUrl,
    accountId: target.accountId,
    workerName: target.workerName,
    versionId: result.versionId,
    previousVersionId,
    bundleDigest: report.bundleDigest,
    bundleBytes: report.bundleBytes,
    configDigest: report.configDigest,
    migrationDigest: report.migrationDigest,
    migrationFiles: report.migrationFiles,
    d1DatabaseId: target.d1.databaseId,
    r2BucketName: target.r2.bucketName,
    publicOrigin: target.publicOrigin,
    grantKeyId: target.grantKeyId,
    postConditions,
  });
  process.stdout.write(`\nevidence appended to ${EVIDENCE_LEDGER}\n`);
}

const argv = process.argv.slice(2);

if (argv.length === 1 && argv[0] === "--contract") {
  process.stdout.write(`${JSON.stringify(DEPLOY_CONTRACT, null, 2)}\n`);
  process.exit(0);
}

const mode = parseMode(argv);
if (mode === null) {
  process.stderr.write(`deploy refused: no target was touched\n\n${USAGE}`);
  process.exit(2);
}

try {
  await run(mode);
} catch (error) {
  if (error instanceof DeployError) {
    process.stderr.write(`deploy failed during ${error.phase}: ${error.message}\n`);
    if (error.detail) process.stderr.write(`\n${error.detail}\n`);
    process.stderr.write(`\n${AFTERMATH[error.phase]}\n`);
    process.exit(PHASE_EXIT_CODE[error.phase]);
  }
  throw error;
}
