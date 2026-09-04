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
  await execute(
    `INSERT INTO tf_artifact_consumer_resolution_receipts
       (receipt_id, tenant_id, deployment_id, uncertainty_fence, idempotency_key,
        plan_digest, snapshot_digest, resolution, manifest_digest,
        provider_evidence_digest, deployment_state_before,
        deployment_updated_at_before, created_at)
     VALUES ('acr_d1_fixture', 'tenant_receipt_d1', 'dep_receipt_d1', 1,
             'repair:d1:fixture', ${sqlText(manifestDigest)}, ${sqlText(manifestDigest)},
             'terminalized_absent', NULL, ${sqlText(blobDigest)}, 'retained', 100, 100)`,
  );
  await expectExecuteFailure(
    "UPDATE tf_artifact_consumer_resolution_receipts SET created_at = 101 WHERE receipt_id = 'acr_d1_fixture'",
    "artifact_consumer_resolution_receipt_immutable",
  );
  await expectExecuteFailure(
    "DELETE FROM tf_artifact_consumer_resolution_receipts WHERE receipt_id = 'acr_d1_fixture'",
    "artifact_consumer_resolution_receipt_durable",
  );
  await execute(
    `INSERT INTO sponsorship_credential_issuance_operations
       (issuance_operation_id, input_sha256, request_sha256,
        request_nonce_sha256, tenant_ref, org_id, hosted_version_id,
        issued_at_epoch_seconds, expires_at_epoch_seconds, token_id,
        credential_key_id, receipt_key_id, authority_version_id,
        authority_source_commit, authority_artifact_sha256, created_at)
     VALUES ('sha256:${"8".repeat(64)}', 'sha256:${"9".repeat(64)}',
             'sha256:${"a".repeat(64)}', 'sha256:${"b".repeat(64)}',
             'tenant:migration-check', 'org:migration-check',
             '33333333-3333-4333-8333-333333333333', 100, 400,
             'tok_sponsor_migration_check', 'credential-key-check',
             'receipt-key-check', '44444444-4444-4444-8444-444444444444',
             '${"b".repeat(40)}', 'sha256:${"c".repeat(64)}',
             '2026-09-04T00:00:00.000Z')`,
  );
  await expectExecuteFailure(
    "UPDATE sponsorship_credential_issuance_operations SET token_id = 'tok_changed'",
    "sponsorship credential issuance operations are append-only",
  );
  const issuance = firstResult(
    await execute(
      `SELECT operation.tenant_ref, operation.org_id,
              (SELECT COUNT(*) FROM sponsorship_tenants AS tenant
               WHERE tenant.tenant_ref = operation.tenant_ref
                 AND tenant.org_id = operation.org_id) AS binding_count
       FROM sponsorship_credential_issuance_operations AS operation`,
    ),
  );
  if (
    issuance.tenant_ref !== "tenant:migration-check" ||
    issuance.org_id !== "org:migration-check" ||
    issuance.binding_count !== 1
  ) {
    throw new Error(
      `D1 sponsorship issuance admission readback failed: ${JSON.stringify(issuance)}`,
    );
  }
  await execute(
    `INSERT INTO sponsorship_cutover_operation_starts
       (operation_id, target_sha256, environment, stage, proof_sha256,
        predecessor_deployment_id, predecessor_version_id,
        predecessor_topology_sha256, source_commit, bundle_sha256,
        config_sha256, candidate_identity_sha256, started_at)
     VALUES ('sha256:${"1".repeat(64)}', 'sha256:${"2".repeat(64)}',
             'integration', 'public-route-removal', 'sha256:${"3".repeat(64)}',
             'deployment-predecessor', '11111111-1111-4111-8111-111111111111',
             'sha256:${"4".repeat(64)}', '${"a".repeat(40)}',
             'sha256:${"5".repeat(64)}', 'sha256:${"6".repeat(64)}',
             'sha256:${"7".repeat(64)}', '2026-09-04T00:00:00.000Z')`,
  );
  await execute(
    `INSERT INTO sponsorship_cutover_operation_completions
       (operation_id, successor_deployment_id, successor_version_id, completed_at)
     VALUES ('sha256:${"1".repeat(64)}', 'deployment-successor',
             '22222222-2222-4222-8222-222222222222',
             '2026-09-04T00:01:00.000Z')`,
  );
  await expectExecuteFailure(
    "UPDATE sponsorship_cutover_operation_starts SET started_at = '2026-09-04T00:02:00.000Z'",
    "sponsorship cutover starts are append-only",
  );
  await expectExecuteFailure(
    "DELETE FROM sponsorship_cutover_operation_completions",
    "sponsorship cutover completions are append-only",
  );
  await execute(
    `INSERT INTO tf_resource_deletion_attestations
       (tenant_id, resource_uid, space, api_version, kind, name, form_ref_json,
        state, closure_fence, effects_json, created_at, updated_at)
     VALUES ('tenant_execution_evidence_d1', 'uid_execution_evidence_d1', 'main',
             'example.forms.invalid/v1', 'EvidenceThing', 'example',
             ${sqlText(
               JSON.stringify({
                 apiVersion: "example.forms.invalid/v1",
                 kind: "EvidenceThing",
                 definitionVersion: "1.0.0",
                 schemaDigest: `sha256:${"a".repeat(64)}`,
               }),
             )},
             'live', 1, '[]', 700, 700)`,
  );
  await execute(
    `INSERT INTO tf_operations
       (id, tenant_id, operation, state, resource_json, created_at, expires_at)
     VALUES ('op_execution_claimed_d1', 'tenant_execution_evidence_d1',
             'create', 'succeeded', NULL, '2026-09-04T00:00:00.000Z', 701)`,
  );
  await expectExecuteFailure(
    `INSERT INTO tf_resource_execution_evidence
       (tenant_id, resource_uid, operation_id, sequence, action,
        resource_generation, resource_revision, committed_at)
     VALUES ('tenant_execution_evidence_d1', 'uid_execution_evidence_d1',
             'op_execution_claimed_d1', 1, 'create', '1', '1', 700)`,
    "resource_execution_evidence_operation_claimed",
  );
  await execute(
    `INSERT INTO tf_resource_execution_evidence
       (tenant_id, resource_uid, operation_id, sequence, action,
        resource_generation, resource_revision, committed_at)
     VALUES ('tenant_execution_evidence_d1', 'uid_execution_evidence_d1',
             'op_execution_create_d1', 1, 'create', '1', '1', 700)`,
  );
  await expectExecuteFailure(
    `UPDATE tf_resource_execution_evidence SET action = 'update'
     WHERE operation_id = 'op_execution_create_d1'`,
    "resource_execution_evidence_immutable",
  );
  await expectExecuteFailure(
    `DELETE FROM tf_resource_execution_evidence
     WHERE operation_id = 'op_execution_create_d1'`,
    "resource_execution_evidence_durable",
  );
  await expectExecuteFailure(
    `INSERT INTO tf_resource_execution_evidence
       (tenant_id, resource_uid, operation_id, sequence, action,
        resource_generation, resource_revision, committed_at)
     VALUES ('tenant_execution_evidence_d1', 'uid_execution_evidence_d1',
             'op_execution_gap_d1', 3, 'update', '1', '2', 701)`,
    "resource_execution_evidence_noncontiguous",
  );
  await expectExecuteFailure(
    `INSERT INTO tf_resource_execution_evidence
       (tenant_id, resource_uid, operation_id, sequence, action,
        resource_generation, resource_revision, committed_at)
     VALUES ('tenant_execution_evidence_d1', 'uid_execution_evidence_d1',
             'op_execution_second_create_d1', 2, 'create', '1', '2', 701)`,
    "resource_execution_evidence_create_not_first",
  );
  await execute(
    `INSERT INTO tf_resource_execution_evidence
       (tenant_id, resource_uid, operation_id, sequence, action,
        resource_generation, resource_revision, committed_at)
     VALUES ('tenant_execution_evidence_d1', 'uid_execution_evidence_d1',
             'op_execution_delete_d1', 2, 'delete', '1', '1', 702)`,
  );
  await expectExecuteFailure(
    `INSERT INTO tf_resource_execution_evidence
       (tenant_id, resource_uid, operation_id, sequence, action,
        resource_generation, resource_revision, committed_at)
     VALUES ('tenant_execution_evidence_d1', 'uid_execution_evidence_d1',
             'op_execution_after_delete_d1', 3, 'update', '1', '3', 703)`,
    "resource_execution_evidence_deleted",
  );
  const executionEvidence = firstResult(
    await execute(
      `SELECT COUNT(*) AS evidence_count, MIN(sequence) AS first_sequence,
              MAX(sequence) AS last_sequence
       FROM tf_resource_execution_evidence
       WHERE tenant_id = 'tenant_execution_evidence_d1'
         AND resource_uid = 'uid_execution_evidence_d1'`,
    ),
  );
  if (
    executionEvidence.evidence_count !== 2 ||
    executionEvidence.first_sequence !== 1 ||
    executionEvidence.last_sequence !== 2
  ) {
    throw new Error(
      `D1 execution-evidence append-only readback failed: ${JSON.stringify(executionEvidence)}`,
    );
  }
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
    "SELECT name FROM sqlite_schema WHERE type = 'table' AND name IN ('integration_e2e_credential_pair_operations', 'provision_token_consumptions', 'runtime_grant_keys', 'runtime_grant_replays', 'runtime_resources', 'sponsorship_credential_issuance_operations', 'sponsorship_cutover_operation_completions', 'sponsorship_cutover_operation_starts', 'sponsorship_resources', 'sponsorship_tenants', 'tf_artifact_blob_io_leases', 'tf_artifact_blob_io_results', 'tf_artifact_consumer_resolution_receipts', 'tf_artifact_consumer_uncertainties', 'tf_artifact_gc_candidates', 'tf_artifact_gc_guards', 'tf_artifact_manifest_members', 'tf_artifact_owner_closure_receipts', 'tf_artifact_recovery_candidates', 'tf_artifact_recovery_details', 'tf_artifact_recovery_once', 'tf_artifact_roots', 'tf_cloudflare_provider_executor_operations', 'tf_deferred_operations', 'tf_operation_commit_guards', 'tf_provider_mutation_sagas', 'tf_resource_attachments', 'tf_resource_claims', 'tf_resource_deletion_attestations', 'tf_resource_deployments', 'tf_resource_execution_evidence', 'tf_resource_provider_effects', 'wallet_credit_allocations', 'wallet_credit_lots', 'worker_endpoint_origin_reservations', 'worker_runtime_input_preparations') ORDER BY name",
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
      "sponsorship_credential_issuance_operations",
      "sponsorship_cutover_operation_completions",
      "sponsorship_cutover_operation_starts",
      "sponsorship_resources",
      "sponsorship_tenants",
      "tf_artifact_blob_io_leases",
      "tf_artifact_blob_io_results",
      "tf_artifact_consumer_resolution_receipts",
      "tf_artifact_consumer_uncertainties",
      "tf_artifact_gc_candidates",
      "tf_artifact_gc_guards",
      "tf_artifact_manifest_members",
      "tf_artifact_owner_closure_receipts",
      "tf_artifact_recovery_candidates",
      "tf_artifact_recovery_details",
      "tf_artifact_recovery_once",
      "tf_artifact_roots",
      "tf_cloudflare_provider_executor_operations",
      "tf_deferred_operations",
      "tf_operation_commit_guards",
      "tf_provider_mutation_sagas",
      "tf_resource_attachments",
      "tf_resource_claims",
      "tf_resource_deletion_attestations",
      "tf_resource_deployments",
      "tf_resource_execution_evidence",
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
