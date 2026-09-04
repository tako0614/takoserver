import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repository = resolve(import.meta.dir, "..");
const persistence = mkdtempSync(join(tmpdir(), "takoserver-d1-migrations-"));
const wrangler = resolve(repository, "node_modules/.bin/wrangler");
const config = resolve(repository, "wrangler.jsonc");

interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function capture(args: readonly string[]): Promise<CommandResult> {
  const child = Bun.spawn([wrangler, ...args], {
    cwd: repository,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, CI: "1" },
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

async function run(args: readonly string[]): Promise<string> {
  const result = await capture(args);
  if (result.exitCode !== 0) {
    process.stderr.write(result.stdout);
    process.stderr.write(result.stderr);
    throw new Error(`wrangler exited with ${result.exitCode}`);
  }
  return result.stdout;
}

try {
  await run([
    "d1",
    "migrations",
    "apply",
    "STATE_DB",
    "--local",
    "--persist-to",
    persistence,
    "--config",
    config,
  ]);
  const manifestDigest = `sha256:${"a".repeat(64)}`;
  const blobDigest = `sha256:${"b".repeat(64)}`;
  const manifestJson = JSON.stringify({
    apiVersion: "artifacts.takoform.com/v1alpha1",
    kind: "WorkerBundle",
    mainModule: "worker.mjs",
    modules: [
      {
        name: "worker.mjs",
        mediaType: "application/javascript+module",
        size: 1,
        digest: blobDigest,
      },
    ],
  });
  const executeArgs = (command: string): readonly string[] => [
    "d1",
    "execute",
    "STATE_DB",
    "--local",
    "--persist-to",
    persistence,
    "--config",
    config,
    "--json",
    "--command",
    command,
  ];
  const execute = async (command: string): Promise<string> => await run(executeArgs(command));
  const expectExecuteFailure = async (command: string, expected: string): Promise<void> => {
    const result = await capture(executeArgs(command));
    if (result.exitCode === 0) throw new Error(`D1 command unexpectedly succeeded: ${command}`);
    if (!`${result.stdout}\n${result.stderr}`.includes(expected)) {
      throw new Error(`D1 failure did not contain ${expected}: ${result.stdout}${result.stderr}`);
    }
  };
  await execute(
    `INSERT INTO tf_artifact_uploads
       (id, tenant_id, principal_id, manifest_json, manifest_digest, created_at)
     VALUES ('up_previous_d1', 'tenant_previous_d1', 'run:previous-d1',
             ${sqlText(manifestJson)}, ${sqlText(manifestDigest)}, 100)`,
  );
  await execute(
    `INSERT INTO tf_artifact_replays (replay_key, status, body_json, expires_at)
     VALUES ('tenant_previous_d1' || char(0) || 'run:previous-d1' || char(0) ||
             'start' || char(0) || 'previous-start-d1', 201,
             ${sqlText(JSON.stringify({ uploadId: "up_previous_d1", manifestDigest }))},
             86400100)`,
  );
  await execute(
    `INSERT OR IGNORE INTO tf_artifact_manifests (digest, manifest_json, created_at)
     VALUES (${sqlText(manifestDigest)}, ${sqlText(manifestJson)}, 200)`,
  );
  await execute(
    `INSERT OR IGNORE INTO tf_artifact_holds (tenant_id, digest, kind)
     VALUES ('tenant_previous_d1', ${sqlText(manifestDigest)}, 'manifest')`,
  );
  await execute(
    `INSERT OR IGNORE INTO tf_artifact_holds (tenant_id, digest, kind)
     VALUES ('tenant_previous_d1', ${sqlText(blobDigest)}, 'blob')`,
  );
  await execute(
    `INSERT INTO tf_artifact_replays (replay_key, status, body_json, expires_at)
     VALUES ('tenant_previous_d1' || char(0) || 'run:previous-d1' || char(0) ||
             'POST' || char(0) ||
             '/apis/forms.takoform.com/v1/artifacts/uploads/up_previous_d1/commit' ||
             char(0) || 'previous-commit-d1', 201,
             ${sqlText(JSON.stringify({ manifestDigest }))}, 86400200)`,
  );
  const compatibilityRaw = await execute(
    `SELECT upload.lifecycle_state, upload.lifecycle_fence,
            (SELECT COUNT(*) FROM tf_artifact_manifest_members AS member
             WHERE member.manifest_digest = upload.manifest_digest
               AND member.blob_digest = ${sqlText(blobDigest)}) AS member_count,
            (SELECT COUNT(*) FROM tf_artifact_roots AS root
             WHERE root.tenant_id = upload.tenant_id AND root.root_kind = 'upload'
               AND root.root_id = upload.id AND root.digest = upload.manifest_digest
               AND root.state = 'active' AND root.fence = 2) AS upload_root_count,
            (SELECT COUNT(*) FROM tf_artifact_roots AS root
             WHERE root.tenant_id = upload.tenant_id AND root.root_kind = 'replay'
               AND root.digest = upload.manifest_digest AND root.state = 'active') AS replay_root_count,
            (SELECT COUNT(*) FROM tf_artifact_uploads AS dangling
             WHERE dangling.lifecycle_state = 'committed'
               AND NOT EXISTS (
                 SELECT 1 FROM tf_artifact_roots AS root
                 WHERE root.tenant_id = dangling.tenant_id AND root.root_kind = 'upload'
                   AND root.root_id = dangling.id AND root.target_kind = 'manifest'
                   AND root.digest = dangling.manifest_digest
               )) AS dangling_committed_uploads
     FROM tf_artifact_uploads AS upload WHERE upload.id = 'up_previous_d1'`,
  );
  const compatibility = firstResult(compatibilityRaw);
  if (
    compatibility.lifecycle_state !== "committed" ||
    compatibility.lifecycle_fence !== 2 ||
    compatibility.member_count !== 1 ||
    compatibility.upload_root_count !== 1 ||
    compatibility.replay_root_count !== 2 ||
    compatibility.dangling_committed_uploads !== 0
  ) {
    throw new Error(
      `D1 previous-writer compatibility readback failed: ${JSON.stringify(compatibility)}`,
    );
  }
  const replacedManifestDigest = `sha256:${"c".repeat(64)}`;
  const replacedReplayKey =
    `'tenant_replaced_d1' || char(0) || 'run:replaced-d1' || char(0) || ` +
    `'POST' || char(0) || ` +
    `'/apis/forms.takoform.com/v1/artifacts/uploads/up_replaced_d1/commit' || ` +
    `char(0) || 'replaced-commit-d1'`;
  await execute(
    `INSERT INTO tf_artifact_replays (replay_key, status, body_json, expires_at)
     VALUES (${replacedReplayKey}, 500,
             ${sqlText(JSON.stringify({ manifestDigest: replacedManifestDigest }))}, 1)`,
  );
  await execute(
    `INSERT INTO tf_artifact_uploads
       (id, tenant_id, principal_id, manifest_json, manifest_digest, created_at)
     VALUES ('up_replaced_d1', 'tenant_replaced_d1', 'run:replaced-d1',
             ${sqlText(manifestJson)}, ${sqlText(replacedManifestDigest)}, 300)`,
  );
  await execute(
    `INSERT INTO tf_artifact_replays (replay_key, status, body_json, expires_at)
     VALUES (${replacedReplayKey}, 201,
             ${sqlText(JSON.stringify({ manifestDigest: replacedManifestDigest }))}, 86400400)
     ON CONFLICT (replay_key) DO UPDATE SET
       status = excluded.status, body_json = excluded.body_json,
       expires_at = excluded.expires_at`,
  );
  const replaced = firstResult(
    await execute(
      `SELECT upload.lifecycle_state, upload.lifecycle_fence,
              (SELECT COUNT(*) FROM tf_artifact_roots AS root
               WHERE root.tenant_id = upload.tenant_id AND root.root_kind = 'replay'
                 AND root.root_id = ${replacedReplayKey}
                 AND root.digest = upload.manifest_digest AND root.state = 'active'
                 AND root.fence = 2 AND root.expires_at = 86400400) AS replay_root_count
       FROM tf_artifact_uploads AS upload WHERE upload.id = 'up_replaced_d1'`,
    ),
  );
  if (
    replaced.lifecycle_state !== "committed" ||
    replaced.lifecycle_fence !== 2 ||
    replaced.replay_root_count !== 1
  ) {
    throw new Error(
      `D1 replaced-replay compatibility readback failed: ${JSON.stringify(replaced)}`,
    );
  }
  const abandonedReplayKey =
    `'tenant_abandoned_d1' || char(0) || 'run:abandoned-d1' || char(0) || ` +
    `'POST' || char(0) || ` +
    `'/apis/forms.takoform.com/v1/artifacts/uploads/up_abandoned_d1/commit' || ` +
    `char(0) || 'abandoned-commit-d1'`;
  await execute(
    `INSERT INTO tf_artifact_uploads
       (id, tenant_id, principal_id, manifest_json, manifest_digest, created_at)
     VALUES ('up_abandoned_d1', 'tenant_abandoned_d1', 'run:abandoned-d1',
             ${sqlText(manifestJson)}, ${sqlText(manifestDigest)}, 400)`,
  );
  await execute("DELETE FROM tf_artifact_uploads WHERE id = 'up_abandoned_d1'");
  await expectExecuteFailure(
    `INSERT INTO tf_artifact_replays (replay_key, status, body_json, expires_at)
     VALUES (${abandonedReplayKey}, 201,
             ${sqlText(JSON.stringify({ manifestDigest }))}, 86400500)`,
    "artifact_upload_abandoned",
  );
  const abandoned = firstResult(
    await execute(
      `SELECT lifecycle_state,
              (SELECT COUNT(*) FROM tf_artifact_replays
               WHERE replay_key = ${abandonedReplayKey}) AS replay_count
       FROM tf_artifact_uploads WHERE id = 'up_abandoned_d1'`,
    ),
  );
  if (abandoned.lifecycle_state !== "abandoned" || abandoned.replay_count !== 0) {
    throw new Error(`D1 abandoned-upload fence readback failed: ${JSON.stringify(abandoned)}`);
  }
  await execute(
    `INSERT INTO tf_artifact_replays (replay_key, status, body_json, expires_at)
     VALUES ('tenant_abandoned_d1' || char(0) || 'run:abandoned-d1' || char(0) ||
             'DELETE' || char(0) ||
             '/apis/forms.takoform.com/v1/artifacts/uploads/up_abandoned_d1' ||
             char(0) || 'abandoned-delete-d1', 204, NULL, 86400600)`,
  );
  const abandonedReleased = firstResult(
    await execute(
      `SELECT upload.abandoned_at, root.state AS root_state, root.fence AS root_fence
       FROM tf_artifact_uploads AS upload
       JOIN tf_artifact_roots AS root
         ON root.tenant_id = upload.tenant_id AND root.root_kind = 'upload'
        AND root.root_id = upload.id AND root.digest = upload.manifest_digest
       WHERE upload.id = 'up_abandoned_d1'`,
    ),
  );
  if (
    abandonedReleased.abandoned_at !== 600 ||
    abandonedReleased.root_state !== "released" ||
    abandonedReleased.root_fence !== 2
  ) {
    throw new Error(
      `D1 abandoned-upload release readback failed: ${JSON.stringify(abandonedReleased)}`,
    );
  }
  await execute(
    `INSERT INTO tf_resource_deployments
       (tenant_id, id, resource_uid, offering_id, provider_pack_ref,
        provider_installation_ref, native_id, native_claimed, state,
        observed_json, outputs_json, created_at, updated_at)
     VALUES ('tenant_uncertain_d1', 'dep_uncertain_d1', 'uid_missing_d1',
             'offering.test', 'provider.test', 'installation.test', 'native-test', 0,
             'retained', '{}', '{}', 500, 500)`,
  );
  const uncertain = firstResult(
    await execute(
      `SELECT state, fence FROM tf_artifact_consumer_uncertainties
       WHERE tenant_id = 'tenant_uncertain_d1' AND consumer_id = 'dep_uncertain_d1'`,
    ),
  );
  if (uncertain.state !== "active" || uncertain.fence !== 1) {
    throw new Error(`D1 unresolved-consumer readback failed: ${JSON.stringify(uncertain)}`);
  }
  await expectExecuteFailure(
    `DELETE FROM tf_resource_deployments
     WHERE tenant_id = 'tenant_uncertain_d1' AND id = 'dep_uncertain_d1'`,
    "artifact_deployment_requires_terminal_state",
  );
  await execute(
    `UPDATE tf_resource_deployments SET state = 'deleted', updated_at = 501
     WHERE tenant_id = 'tenant_uncertain_d1' AND id = 'dep_uncertain_d1'`,
  );
  const resolved = firstResult(
    await execute(
      `SELECT state, fence FROM tf_artifact_consumer_uncertainties
       WHERE tenant_id = 'tenant_uncertain_d1' AND consumer_id = 'dep_uncertain_d1'`,
    ),
  );
  if (resolved.state !== "resolved" || resolved.fence !== 2) {
    throw new Error(`D1 resolved-consumer readback failed: ${JSON.stringify(resolved)}`);
  }
  const fencedBlobDigest = `sha256:${"e".repeat(64)}`;
  const fencedManifestDigest = `sha256:${"f".repeat(64)}`;
  const fencedManifestJson = JSON.stringify({
    apiVersion: "artifacts.takoform.com/v1alpha1",
    kind: "WorkerBundle",
    mainModule: "worker.mjs",
    modules: [
      {
        name: "worker.mjs",
        mediaType: "application/javascript+module",
        size: 1,
        digest: fencedBlobDigest,
      },
    ],
  });
  await execute(
    `INSERT INTO tf_artifact_gc_candidates
       (kind, digest, state, fence, not_before, expected_etag, attempts,
        last_outcome, created_at, updated_at, deleted_at)
     VALUES ('blob', ${sqlText(fencedBlobDigest)}, 'deleting', 2, 1,
             'etag-delete-fenced', 1, 'claimed', 1, 1, NULL)`,
  );
  await expectExecuteFailure(
    `INSERT INTO tf_artifact_uploads
       (id, tenant_id, principal_id, manifest_json, manifest_digest, created_at)
     VALUES ('up_delete_fenced_d1', 'tenant_delete_fenced_d1', 'run:previous-d1',
             ${sqlText(fencedManifestJson)}, ${sqlText(fencedManifestDigest)}, 2)`,
    "artifact_gc_delete_fenced",
  );
  const raw = await run([
    "d1",
    "execute",
    "STATE_DB",
    "--local",
    "--persist-to",
    persistence,
    "--config",
    config,
    "--json",
    "--command",
    "SELECT name FROM sqlite_schema WHERE type = 'table' AND name IN ('integration_e2e_credential_pair_operations', 'provision_token_consumptions', 'runtime_grant_keys', 'runtime_grant_replays', 'runtime_resources', 'sponsorship_resources', 'sponsorship_tenants', 'tf_artifact_blob_io_leases', 'tf_artifact_blob_io_results', 'tf_artifact_consumer_uncertainties', 'tf_artifact_gc_candidates', 'tf_artifact_gc_guards', 'tf_artifact_manifest_members', 'tf_artifact_owner_closure_receipts', 'tf_artifact_roots', 'tf_deferred_operations', 'tf_operation_commit_guards', 'tf_provider_mutation_sagas', 'tf_resource_attachments', 'tf_resource_claims', 'tf_resource_deletion_attestations', 'tf_resource_deployments', 'tf_resource_provider_effects', 'wallet_credit_allocations', 'wallet_credit_lots', 'worker_endpoint_origin_reservations', 'worker_runtime_input_preparations') ORDER BY name",
  ]);
  const value: unknown = JSON.parse(raw);
  if (!Array.isArray(value) || !isRecord(value[0]) || !Array.isArray(value[0].results)) {
    throw new Error("unexpected D1 schema probe response");
  }
  const names = value[0].results
    .filter(isRecord)
    .map((row) => row.name)
    .filter((name): name is string => typeof name === "string");
  if (
    JSON.stringify(names) !==
    JSON.stringify([
      "integration_e2e_credential_pair_operations",
      "provision_token_consumptions",
      "runtime_grant_keys",
      "runtime_grant_replays",
      "runtime_resources",
      "sponsorship_resources",
      "sponsorship_tenants",
      "tf_artifact_blob_io_leases",
      "tf_artifact_blob_io_results",
      "tf_artifact_consumer_uncertainties",
      "tf_artifact_gc_candidates",
      "tf_artifact_gc_guards",
      "tf_artifact_manifest_members",
      "tf_artifact_owner_closure_receipts",
      "tf_artifact_roots",
      "tf_deferred_operations",
      "tf_operation_commit_guards",
      "tf_provider_mutation_sagas",
      "tf_resource_attachments",
      "tf_resource_claims",
      "tf_resource_deletion_attestations",
      "tf_resource_deployments",
      "tf_resource_provider_effects",
      "wallet_credit_allocations",
      "wallet_credit_lots",
      "worker_endpoint_origin_reservations",
      "worker_runtime_input_preparations",
    ])
  ) {
    throw new Error(`D1 schema probe returned unexpected tables: ${JSON.stringify(names)}`);
  }
} finally {
  rmSync(persistence, { recursive: true, force: true });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sqlText(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function firstResult(raw: string): Record<string, unknown> {
  const value: unknown = JSON.parse(raw);
  if (
    !Array.isArray(value) ||
    !isRecord(value[0]) ||
    !Array.isArray(value[0].results) ||
    !isRecord(value[0].results[0])
  ) {
    throw new Error("unexpected D1 compatibility probe response");
  }
  return value[0].results[0];
}
