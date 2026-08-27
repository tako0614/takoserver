import { canonicalDigest, canonicalJson, isJsonObject, isSha256Digest } from "../json.ts";
import type { Clock, ObjectStore, Row, Sql, SqlWrite } from "../ports.ts";
import { ObjectStoreError, SqlError } from "../ports.ts";
import {
  ADMISSION_GENESIS_DIGEST,
  type AdmissionCommandMetadata,
  type AdmissionDigest,
  FormAdmissionError as AdmissionError,
  type AdmissionHandleClaims,
  type AdmissionHandleIssuer,
  type AdmissionPublisherPin,
  type AdmissionQuery,
  type AdmissionReceipt,
  type AllowPublisher,
  type AppendCheckpoint,
  type BeginEvacuation,
  commandKind,
  type DenyPublisher,
  digestAdmissionReport,
  type FormAdmissionHost,
  type InstallPackage,
  type PurgePackage,
  type ReplacePackage,
  type RotatePublisher,
  type SetActivation,
  type SetSupport,
  type SettleEvacuation,
  type UninstallPackage,
  validateDigest,
} from "./admission.ts";
import {
  createFormPackageStore,
  type FormPackageError,
  type FormPackageInput,
  type FormPackageStore,
  type StoredFormPackage,
} from "./form-packages.ts";
import { isFormGroup, validateFormRef } from "./forms.ts";

const PUBLISHER_TABLE = "tf_form_publisher_events" as const;
const CHECKPOINT_TABLE = "tf_form_revocation_checkpoints" as const;
const INSTALL_TABLE = "tf_form_install_events" as const;
const PURGE_TABLE = "tf_form_package_purge_events" as const;
const SUPPORT_TABLE = "tf_form_support_events" as const;
const ACTIVATION_TABLE = "tf_form_activation_events" as const;
const EVACUATION_TABLE = "tf_form_evacuation_events" as const;

export interface CreateFormAdmissionStoreOptions {
  readonly sql: Sql;
  readonly packages?: FormPackageStore;
  readonly objects?: ObjectStore;
  readonly handles: AdmissionHandleIssuer;
  readonly clock?: Clock;
  readonly randomId?: () => string;
}

/**
 * Creates the private, durable Host substrate.  This function is intentionally
 * not imported by the public router: callers must be explicit operator code
 * with a Core-issued in-process handle for package installation.
 */
export function createFormAdmissionStore(
  options: CreateFormAdmissionStoreOptions,
): FormAdmissionHost {
  if (
    !options ||
    typeof options !== "object" ||
    !options.sql ||
    typeof options.sql.query !== "function" ||
    typeof options.sql.run !== "function" ||
    typeof options.sql.batch !== "function" ||
    !options.handles ||
    typeof options.handles.issue !== "function" ||
    typeof options.handles.inspect !== "function"
  ) {
    throw new TypeError("SQL and an admission handle issuer are required");
  }
  if (options.clock !== undefined && typeof options.clock !== "function") {
    throw new TypeError("admission clock must be a function");
  }
  if (options.randomId !== undefined && typeof options.randomId !== "function") {
    throw new TypeError("admission id generator must be a function");
  }
  if (
    options.packages &&
    (typeof options.packages.put !== "function" ||
      typeof options.packages.read !== "function" ||
      typeof options.packages.purge !== "function")
  ) {
    throw new TypeError("package store is invalid");
  }
  const clock = options.clock ?? (() => new Date());
  const randomId = options.randomId ?? (() => crypto.randomUUID());
  const packages =
    options.packages ?? (options.objects ? createFormPackageStore(options.objects) : null);

  return {
    inspect: (query) => inspectAdmission(options.sql, query, clock),
    execute: async (command) => {
      const kind = commandKind(command);
      switch (kind) {
        case "AllowPublisher":
          return executePublisher(options.sql, command as AllowPublisher, "allow", clock, randomId);
        case "RotatePublisher":
          return executePublisher(
            options.sql,
            command as RotatePublisher,
            "rotate",
            clock,
            randomId,
          );
        case "DenyPublisher":
          return executePublisher(options.sql, command as DenyPublisher, "deny", clock, randomId);
        case "AppendCheckpoint":
          return executeCheckpoint(options.sql, command as AppendCheckpoint, clock, randomId);
        case "InstallPackage":
          return executeInstall(
            options.sql,
            command as InstallPackage,
            "install",
            options.handles,
            packages,
            clock,
            randomId,
          );
        case "ReplacePackage":
          return executeInstall(
            options.sql,
            command as ReplacePackage,
            "replace",
            options.handles,
            packages,
            clock,
            randomId,
          );
        case "UninstallPackage":
          return executeUninstall(options.sql, command as UninstallPackage, clock, randomId);
        case "PurgePackage":
          return executePurge(options.sql, command as PurgePackage, packages, clock, randomId);
        case "SetSupport":
          return executeSupport(options.sql, command as SetSupport, clock, randomId);
        case "SetActivation":
          return executeActivation(options.sql, command as SetActivation, clock, randomId);
        case "BeginEvacuation":
          return executeBeginEvacuation(options.sql, command as BeginEvacuation, clock, randomId);
        case "SettleEvacuation":
          return executeSettleEvacuation(options.sql, command as SettleEvacuation, clock, randomId);
        default:
          throw new AdmissionError("invalid_command", `unknown admission command: ${kind}`);
      }
    },
  };
}

async function executePublisher(
  sql: Sql,
  command: AllowPublisher | RotatePublisher | DenyPublisher,
  eventType: "allow" | "rotate" | "deny",
  clock: Clock,
  randomId: () => string,
): Promise<AdmissionReceipt> {
  const publisher = normalizePublisher(command.publisher);
  const publisherKey = await publisherKeyOf(publisher);
  const current = await head(sql, PUBLISHER_TABLE, "publisher_key", publisherKey);
  if (eventType === "allow" && current) {
    throw new AdmissionError("admission_conflict", "publisher already has a policy head");
  }
  if (eventType !== "allow" && !current) {
    throw new AdmissionError("admission_missing", "publisher policy head is missing");
  }
  const predecessor =
    command.predecessorDigest ??
    (current
      ? digestOf(current.predecessor_digest, current.event_digest)
      : ADMISSION_GENESIS_DIGEST);
  validateDigest(predecessor, "publisher predecessor digest");
  if (!current && predecessor !== ADMISSION_GENESIS_DIGEST) {
    throw new AdmissionError(
      "admission_conflict",
      "first publisher policy event must start at genesis",
    );
  }
  if (eventType !== "allow" && current?.event_digest !== predecessor) {
    throw new AdmissionError("admission_conflict", "publisher policy head moved");
  }
  const id = eventId(randomId);
  const eventAt = eventTime(command, clock);
  const policyJson = canonicalJson(publisher.policy ?? {});
  const eventDigest = await canonicalDigest({
    chain: "publisher",
    id,
    publisherKey,
    eventType,
    publisher,
    policyJson,
    actor: command.actor,
    reason: command.reason,
    eventAt,
    predecessorDigest: predecessor,
  });
  const written = await guarded(
    sql.run(
      `INSERT INTO ${PUBLISHER_TABLE}
         (id, publisher_key, event_type, policy_digest, policy_json,
          oidc_issuer, source_repository, workflow, ref, publisher_identity,
          source_commit, workflow_commit, repository_identifier, owner_identifier,
          namespace_group, namespace_grant_digest, trusted_root_digest,
          actor, reason, event_at, event_digest, predecessor_digest)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
       WHERE ${
         eventType === "allow"
           ? `NOT EXISTS (
         SELECT 1 FROM ${PUBLISHER_TABLE} WHERE publisher_key = ?
       )`
           : `EXISTS (
         SELECT 1 FROM ${PUBLISHER_TABLE} AS current
         WHERE current.publisher_key = ?
           AND current.event_digest = ?
           AND NOT EXISTS (
             SELECT 1 FROM ${PUBLISHER_TABLE} AS successor
             WHERE successor.publisher_key = current.publisher_key
               AND successor.predecessor_digest = current.event_digest
           )
       )`
}`,
      [
        id,
        publisherKey,
        eventType,
        publisher.policyDigest,
        policyJson,
        publisher.oidcIssuer,
        publisher.sourceRepository,
        publisher.workflow,
        publisher.ref,
        publisher.identity,
        publisher.sourceCommit,
        publisher.workflowCommit,
        publisher.repositoryIdentifier,
        publisher.ownerIdentifier,
        publisher.group,
        publisher.namespaceGrantDigest,
        publisher.trustedRootDigest,
        command.actor,
        command.reason,
        eventAt,
        eventDigest,
        predecessor,
        ...(eventType === "allow" ? [publisherKey] : [publisherKey, predecessor]),
      ],
    ),
    "publisher policy transition",
  );
  return {
    eventDigest,
    state: eventType,
    changed: written.changes === 1,
  };
}

async function executeCheckpoint(
  sql: Sql,
  command: AppendCheckpoint,
  clock: Clock,
  randomId: () => string,
): Promise<AdmissionReceipt> {
  requireText(command.publisherKey, "publisher key");
  requireInteger(command.sequence, "checkpoint sequence");
  if (command.sequence < 1)
    throw new AdmissionError("checkpoint_invalid", "sequence starts at one");
  validateDigest(command.policyDigest, "policy digest");
  validateDigest(command.policyEventDigest, "policy event digest");
  validateDigest(command.checkpointDigest, "checkpoint digest");
  validateDigest(command.entriesDigest, "entries digest");
  validateDigest(command.previousCheckpointDigest, "previous checkpoint digest");
  const currentCheckpoint = await head(
    sql,
    CHECKPOINT_TABLE,
    "publisher_key",
    command.publisherKey,
  );
  const currentPublisher = await head(sql, PUBLISHER_TABLE, "publisher_key", command.publisherKey);
  if (!currentPublisher)
    throw new AdmissionError("admission_missing", "publisher policy is missing");
  const predecessor =
    command.predecessorDigest ??
    (currentCheckpoint ? text(currentCheckpoint.event_digest) : ADMISSION_GENESIS_DIGEST);
  const expectedPrevious = currentCheckpoint
    ? text(currentCheckpoint.checkpoint_digest)
    : ADMISSION_GENESIS_DIGEST;
  if (
    predecessor !==
    (currentCheckpoint ? text(currentCheckpoint.event_digest) : ADMISSION_GENESIS_DIGEST)
  ) {
    throw new AdmissionError("admission_conflict", "checkpoint predecessor moved");
  }
  if (command.previousCheckpointDigest !== expectedPrevious) {
    throw new AdmissionError("checkpoint_invalid", "checkpoint sequence predecessor mismatch");
  }
  if (
    command.revokedPackageDigests !== undefined &&
    !Array.isArray(command.revokedPackageDigests)
  ) {
    throw new AdmissionError("checkpoint_invalid", "revoked package digests must be an array");
  }
  const revoked = [...(command.revokedPackageDigests ?? [])];
  for (const digest of revoked) validateDigest(digest, "revoked package digest");
  const revokedJson = canonicalJson(revoked);
  const id = eventId(randomId);
  const eventAt = eventTime(command, clock);
  const eventDigest = await canonicalDigest({
    chain: "checkpoint",
    id,
    publisherKey: command.publisherKey,
    sequence: command.sequence,
    checkpointDigest: command.checkpointDigest,
    entriesDigest: command.entriesDigest,
    previousCheckpointDigest: command.previousCheckpointDigest,
    revokedPackageDigests: revoked,
    policyDigest: command.policyDigest,
    policyEventDigest: command.policyEventDigest,
    actor: command.actor,
    reason: command.reason,
    eventAt,
    predecessorDigest: predecessor,
  });
  const written = await guarded(
    sql.run(
      `WITH checkpoint_head AS (
         SELECT sequence, checkpoint_digest, event_digest
         FROM ${CHECKPOINT_TABLE} AS current
         WHERE current.publisher_key = ?
           AND NOT EXISTS (
             SELECT 1 FROM ${CHECKPOINT_TABLE} AS successor
             WHERE successor.publisher_key = current.publisher_key
               AND successor.predecessor_digest = current.event_digest
           )
         LIMIT 1
       ), publisher_head AS (
         SELECT event_digest, policy_digest
         FROM ${PUBLISHER_TABLE} AS current
         WHERE current.publisher_key = ?
           AND NOT EXISTS (
             SELECT 1 FROM ${PUBLISHER_TABLE} AS successor
             WHERE successor.publisher_key = current.publisher_key
               AND successor.predecessor_digest = current.event_digest
           )
         LIMIT 1
       )
       INSERT INTO ${CHECKPOINT_TABLE}
         (id, publisher_key, sequence, checkpoint_digest, entries_digest,
          previous_checkpoint_digest, revoked_package_digests_json,
          policy_digest, policy_event_digest, actor, reason, event_at,
          event_digest, predecessor_digest)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
       WHERE COALESCE((SELECT sequence FROM checkpoint_head), 0) + 1 = ?
         AND COALESCE((SELECT checkpoint_digest FROM checkpoint_head), ?) = ?
         AND COALESCE((SELECT event_digest FROM checkpoint_head), ?) = ?
         AND (SELECT event_digest FROM publisher_head) = ?
         AND (SELECT policy_digest FROM publisher_head) = ?`,
      [
        command.publisherKey,
        command.publisherKey,
        id,
        command.publisherKey,
        command.sequence,
        command.checkpointDigest,
        command.entriesDigest,
        command.previousCheckpointDigest,
        revokedJson,
        command.policyDigest,
        command.policyEventDigest,
        command.actor,
        command.reason,
        eventAt,
        eventDigest,
        predecessor,
        command.sequence,
        ADMISSION_GENESIS_DIGEST,
        command.previousCheckpointDigest,
        ADMISSION_GENESIS_DIGEST,
        predecessor,
        command.policyEventDigest,
        command.policyDigest,
      ],
    ),
    "revocation checkpoint transition",
  );
  return { eventDigest, state: "checkpoint", changed: written.changes === 1 };
}

async function executeInstall(
  sql: Sql,
  command: InstallPackage | ReplacePackage,
  operation: "install" | "replace",
  handles: AdmissionHandleIssuer,
  packages: FormPackageStore | null,
  clock: Clock,
  randomId: () => string,
): Promise<AdmissionReceipt> {
  if (!command.package || typeof command.package !== "object") {
    throw new AdmissionError("package_invalid", "package input is required");
  }
  if (command.implementationDigest !== undefined) {
    validateDigest(command.implementationDigest, "implementation digest");
  }
  const claims = handles.inspect(command.handle);
  if (!claims)
    throw new AdmissionError("invalid_handle", "package install needs a Core-issued handle");
  assertHandleForCommand(claims, command, operation);
  const formRefKey = await canonicalDigest(claims.formRef);
  const purgeHead = await packagePurgeHead(sql, formRefKey, claims.packageDigest);
  if (purgeHead) {
    throw new AdmissionError(
      "admission_conflict",
      "a package digest with a purge lifecycle cannot be reintroduced",
    );
  }
  if (!packages)
    throw new AdmissionError("package_store_unavailable", "package bytes have no private store");

  let stored: StoredFormPackage;
  try {
    stored = await ensurePackage(packages, command.package);
  } catch (error) {
    throw packageError(error);
  }
  if (
    stored.packageDigest !== claims.packageDigest ||
    canonicalJson(stored.formRef) !== canonicalJson(claims.formRef)
  ) {
    throw new AdmissionError("handle_mismatch", "package bytes do not match the Core handle");
  }

  const current = await head(sql, INSTALL_TABLE, "form_ref_key", formRefKey);
  const predecessor =
    command.predecessorDigest ?? (current ? text(current.event_digest) : ADMISSION_GENESIS_DIGEST);
  if (current && current.event_digest !== predecessor) {
    throw new AdmissionError("admission_conflict", "package install predecessor moved");
  }
  if (operation === "install" && current) {
    throw new AdmissionError("admission_conflict", "Form already has an installed successor");
  }
  if (
    operation === "replace" &&
    (!current || !["install", "replace", "uninstall"].includes(text(current.event_type)))
  ) {
    throw new AdmissionError("admission_missing", "replace needs an installed package head");
  }
  const id = eventId(randomId);
  const eventAt = eventTime(command, clock);
  const report = claims.report;
  const expectedPayloadBytes = stored.files.reduce((total, file) => total + file.size, 0);
  if (
    report.package.fileCount !== stored.files.length ||
    report.package.payloadBytes !== expectedPayloadBytes
  ) {
    throw new AdmissionError(
      "handle_mismatch",
      "admission report package totals do not match bytes",
    );
  }
  const reportDigest = await digestAdmissionReport(report);
  const reportJson = canonicalJson(report);
  const eventDigest = await canonicalDigest({
    chain: "install",
    id,
    formRef: claims.formRef,
    packageDigest: claims.packageDigest,
    operation,
    replacesPackageDigest: current ? text(current.package_digest) : null,
    admissionReportDigest: reportDigest,
    report,
    publisher: claims.publisher,
    policyEventDigest: claims.policyEventDigest,
    checkpointSequence: claims.checkpointSequence,
    checkpointDigest: claims.checkpointDigest,
    checkpointEventDigest: claims.checkpointEventDigest,
    implementationDigest: command.implementationDigest ?? null,
    retentionRef: command.package.retentionRef ?? null,
    retentionUntil: command.package.retentionUntil ?? null,
    actor: command.actor,
    reason: command.reason,
    eventAt,
    predecessorDigest: predecessor,
  });
  let written: SqlWrite;
  try {
    written = await guarded(
      sql.run(
        `WITH install_head AS (
         SELECT event_digest, event_type, package_digest
         FROM ${INSTALL_TABLE} AS current
         WHERE current.form_ref_key = ?
           AND NOT EXISTS (
             SELECT 1 FROM ${INSTALL_TABLE} AS successor
             WHERE successor.form_ref_key = current.form_ref_key
               AND successor.predecessor_digest = current.event_digest
           )
         LIMIT 1
       ), publisher_head AS (
         SELECT event_digest, event_type, policy_digest,
                oidc_issuer, source_repository, workflow, ref,
                publisher_identity, source_commit, workflow_commit,
                repository_identifier, owner_identifier, namespace_group,
                namespace_grant_digest, trusted_root_digest
         FROM ${PUBLISHER_TABLE} AS current
         WHERE current.publisher_key = ?
           AND NOT EXISTS (
             SELECT 1 FROM ${PUBLISHER_TABLE} AS successor
             WHERE successor.publisher_key = current.publisher_key
               AND successor.predecessor_digest = current.event_digest
           )
         LIMIT 1
       ), checkpoint_head AS (
         SELECT event_digest, sequence, checkpoint_digest, entries_digest,
                revoked_package_digests_json
         FROM ${CHECKPOINT_TABLE} AS current
         WHERE current.publisher_key = ?
           AND NOT EXISTS (
             SELECT 1 FROM ${CHECKPOINT_TABLE} AS successor
             WHERE successor.publisher_key = current.publisher_key
               AND successor.predecessor_digest = current.event_digest
           )
         LIMIT 1
       ), purge_head AS (
         SELECT event_digest
         FROM ${PURGE_TABLE} AS current
         WHERE current.form_ref_key = ?
           AND current.package_digest = ?
           AND NOT EXISTS (
             SELECT 1 FROM ${PURGE_TABLE} AS successor
             WHERE successor.form_ref_key = current.form_ref_key
               AND successor.package_digest = current.package_digest
               AND successor.predecessor_digest = current.event_digest
           )
         LIMIT 1
       )
       INSERT INTO ${INSTALL_TABLE}
         (id, form_ref_key, form_ref_json, form_api_version, form_kind,
          form_definition_version, schema_digest, package_digest, event_type,
          replaces_package_digest, admission_report_digest, admission_report_json,
          publisher_key, policy_digest, policy_event_digest, checkpoint_sequence,
          checkpoint_digest, checkpoint_event_digest, source_commit, workflow_commit,
          repository_identifier, owner_identifier, namespace_group,
          namespace_grant_digest, implementation_digest, retention_ref,
          retention_until, actor, reason, event_at, event_digest, predecessor_digest)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
       WHERE COALESCE((SELECT event_digest FROM install_head), ?) = ?
         AND (CASE WHEN ? = 'install' THEN (SELECT event_digest FROM install_head) IS NULL
                   ELSE COALESCE((SELECT event_type FROM install_head), '') IN ('install', 'replace', 'uninstall') END)
         AND (SELECT event_digest FROM publisher_head) = ?
         AND (SELECT event_type FROM publisher_head) IN ('allow', 'rotate')
         AND (SELECT policy_digest FROM publisher_head) = ?
         AND (SELECT oidc_issuer FROM publisher_head) = ?
         AND (SELECT source_repository FROM publisher_head) = ?
         AND (SELECT workflow FROM publisher_head) = ?
         AND (SELECT ref FROM publisher_head) = ?
         AND (SELECT publisher_identity FROM publisher_head) = ?
         AND (SELECT source_commit FROM publisher_head) = ?
         AND (SELECT workflow_commit FROM publisher_head) = ?
         AND (SELECT repository_identifier FROM publisher_head) = ?
         AND (SELECT owner_identifier FROM publisher_head) = ?
         AND (SELECT namespace_group FROM publisher_head) = ?
         AND (SELECT namespace_grant_digest FROM publisher_head) = ?
         AND (SELECT trusted_root_digest FROM publisher_head) = ?
         AND (SELECT event_digest FROM checkpoint_head) = ?
         AND (SELECT sequence FROM checkpoint_head) = ?
         AND (SELECT checkpoint_digest FROM checkpoint_head) = ?
         AND (SELECT entries_digest FROM checkpoint_head) = ?
         AND NOT EXISTS (SELECT 1 FROM purge_head)
         AND NOT EXISTS (
           SELECT 1 FROM json_each(COALESCE((SELECT revoked_package_digests_json FROM checkpoint_head), '[]'))
           WHERE value = ?
         )`,
        [
          formRefKey,
          claims.publisherKey,
          claims.publisherKey,
          formRefKey,
          claims.packageDigest,
          id,
          formRefKey,
          canonicalJson(claims.formRef),
          claims.formRef.apiVersion,
          claims.formRef.kind,
          claims.formRef.definitionVersion,
          claims.formRef.schemaDigest,
          claims.packageDigest,
          operation,
          current ? text(current.package_digest) : null,
          reportDigest,
          reportJson,
          claims.publisherKey,
          claims.publisher.policyDigest,
          claims.policyEventDigest,
          claims.checkpointSequence,
          claims.checkpointDigest,
          claims.checkpointEventDigest,
          claims.publisher.sourceCommit,
          claims.publisher.workflowCommit,
          claims.publisher.repositoryIdentifier,
          claims.publisher.ownerIdentifier,
          claims.publisher.group,
          claims.publisher.namespaceGrantDigest,
          command.implementationDigest ?? null,
          command.package.retentionRef ?? null,
          command.package.retentionUntil ?? null,
          command.actor,
          command.reason,
          eventAt,
          eventDigest,
          predecessor,
          ADMISSION_GENESIS_DIGEST,
          predecessor,
          operation,
          claims.policyEventDigest,
          claims.publisher.policyDigest,
          claims.publisher.oidcIssuer,
          claims.publisher.sourceRepository,
          claims.publisher.workflow,
          claims.publisher.ref,
          claims.publisher.identity,
          claims.publisher.sourceCommit,
          claims.publisher.workflowCommit,
          claims.publisher.repositoryIdentifier,
          claims.publisher.ownerIdentifier,
          claims.publisher.group,
          claims.publisher.namespaceGrantDigest,
          claims.publisher.trustedRootDigest,
          claims.checkpointEventDigest,
          claims.checkpointSequence,
          claims.checkpointDigest,
          claims.report.revocation.entriesDigest,
          claims.packageDigest,
        ],
      ),
      "package install transition",
    );
  } catch (error) {
    try {
      await repairRejectedInstallPackageBytes(
        sql,
        packages,
        claims.formRef,
        formRefKey,
        claims.packageDigest,
        eventDigest,
      );
    } catch (cleanupError) {
      throw packageCleanupError(cleanupError);
    }
    throw error;
  }
  return {
    eventDigest,
    state: operation,
    changed: written.changes === 1,
    packageDigest: claims.packageDigest,
    formRef: structuredClone(claims.formRef),
  };
}

async function executeUninstall(
  sql: Sql,
  command: UninstallPackage,
  clock: Clock,
  randomId: () => string,
): Promise<AdmissionReceipt> {
  validateForm(command.formRef);
  validateDigest(command.packageDigest, "package digest");
  const formRefKey = await canonicalDigest(command.formRef);
  const current = await head(sql, INSTALL_TABLE, "form_ref_key", formRefKey);
  if (!current || text(current.package_digest) !== command.packageDigest) {
    throw new AdmissionError("admission_missing", "installed package is missing");
  }
  if (!["install", "replace"].includes(text(current.event_type))) {
    throw new AdmissionError("admission_conflict", "package is not installed");
  }
  const predecessor = command.predecessorDigest ?? text(current.event_digest);
  if (predecessor !== text(current.event_digest)) {
    throw new AdmissionError("admission_conflict", "package install predecessor moved");
  }
  const id = eventId(randomId);
  const eventAt = eventTime(command, clock);
  const material = installEventMaterial(current);
  const eventDigest = await canonicalDigest({
    chain: "install",
    id,
    eventType: "uninstall",
    ...material,
    actor: command.actor,
    reason: command.reason,
    eventAt,
    predecessorDigest: predecessor,
  });
  const written = await guarded(
    sql.run(
      `INSERT INTO ${INSTALL_TABLE}
         (id, form_ref_key, form_ref_json, form_api_version, form_kind,
          form_definition_version, schema_digest, package_digest, event_type,
          replaces_package_digest, admission_report_digest, admission_report_json,
          publisher_key, policy_digest, policy_event_digest, checkpoint_sequence,
          checkpoint_digest, checkpoint_event_digest, source_commit, workflow_commit,
          repository_identifier, owner_identifier, namespace_group,
          namespace_grant_digest, implementation_digest, retention_ref,
          retention_until, actor, reason, event_at, event_digest, predecessor_digest)
       SELECT ?, form_ref_key, form_ref_json, form_api_version, form_kind,
          form_definition_version, schema_digest, package_digest, 'uninstall',
          replaces_package_digest, admission_report_digest, admission_report_json,
          publisher_key, policy_digest, policy_event_digest, checkpoint_sequence,
          checkpoint_digest, checkpoint_event_digest, source_commit, workflow_commit,
          repository_identifier, owner_identifier, namespace_group,
          namespace_grant_digest, implementation_digest, retention_ref,
          retention_until, ?, ?, ?, ?, ?
       FROM ${INSTALL_TABLE} AS current
       WHERE current.form_ref_key = ?
         AND current.event_digest = ?
         AND NOT EXISTS (
           SELECT 1 FROM ${INSTALL_TABLE} AS successor
           WHERE successor.form_ref_key = current.form_ref_key
             AND successor.predecessor_digest = current.event_digest
         )`,
      [
        id,
        command.actor,
        command.reason,
        eventAt,
        eventDigest,
        predecessor,
        formRefKey,
        predecessor,
      ],
    ),
    "package uninstall transition",
  );
  return {
    eventDigest,
    state: "uninstall",
    changed: written.changes === 1,
    packageDigest: command.packageDigest,
    formRef: structuredClone(command.formRef),
  };
}

async function executePurge(
  sql: Sql,
  command: PurgePackage,
  packages: FormPackageStore | null,
  clock: Clock,
  randomId: () => string,
): Promise<AdmissionReceipt> {
  validateForm(command.formRef);
  validateDigest(command.packageDigest, "package digest");
  if (!packages)
    throw new AdmissionError("package_store_unavailable", "package bytes have no private store");
  const formRefKey = await canonicalDigest(command.formRef);
  const source = await packageInstallSource(sql, formRefKey, command.packageDigest);
  if (!source) {
    throw new AdmissionError("admission_missing", "package install history is missing");
  }
  const installHead = await head(sql, INSTALL_TABLE, "form_ref_key", formRefKey);
  if (
    installHead &&
    text(installHead.package_digest) === command.packageDigest &&
    ["install", "replace"].includes(text(installHead.event_type))
  ) {
    throw new AdmissionError(
      "admission_conflict",
      "the current installed package must be uninstalled before purge",
    );
  }
  let current = await packagePurgeHead(sql, formRefKey, command.packageDigest);
  if (current && text(current.event_type) === "purged") {
    await repairPurgedPackageBytes(sql, packages, command.formRef, command.packageDigest);
    return {
      eventDigest: text(current.event_digest) as AdmissionDigest,
      state: "purged",
      changed: false,
      packageDigest: command.packageDigest,
      formRef: structuredClone(command.formRef),
    };
  }

  if (!current) {
    const predecessor = command.predecessorDigest ?? ADMISSION_GENESIS_DIGEST;
    validateDigest(predecessor, "package purge predecessor digest");
    if (predecessor !== ADMISSION_GENESIS_DIGEST) {
      throw new AdmissionError(
        "admission_conflict",
        "first package purge event must start at genesis",
      );
    }
    const id = eventId(randomId);
    const eventAt = eventTime(command, clock);
    const material = installEventMaterial(source);
    const pendingDigest = await canonicalDigest({
      chain: "package-purge",
      id,
      eventType: "purge-pending",
      sourceInstallEventDigest: text(source.event_digest),
      ...material,
      actor: command.actor,
      reason: command.reason,
      eventAt,
      predecessorDigest: predecessor,
    });
    let pending: SqlWrite;
    try {
      pending = await sql.run(
        `WITH purge_head AS (
           SELECT event_digest
           FROM ${PURGE_TABLE} AS current
           WHERE current.form_ref_key = ?
             AND current.package_digest = ?
             AND NOT EXISTS (
               SELECT 1 FROM ${PURGE_TABLE} AS successor
               WHERE successor.form_ref_key = current.form_ref_key
                 AND successor.package_digest = current.package_digest
                 AND successor.predecessor_digest = current.event_digest
             )
         LIMIT 1
         )
         INSERT INTO ${PURGE_TABLE}
           (id, form_ref_key, form_ref_json, form_api_version, form_kind,
            form_definition_version, schema_digest, package_digest,
            implementation_digest, publisher_key, policy_digest,
            policy_event_digest, checkpoint_sequence, checkpoint_digest,
            checkpoint_event_digest, source_commit, workflow_commit,
            repository_identifier, owner_identifier, namespace_group,
            namespace_grant_digest, admission_report_digest, admission_report_json,
            retention_ref, retention_until, event_type, source_install_event_digest,
            actor, reason, event_at, event_digest, predecessor_digest)
         SELECT ?, source.form_ref_key, source.form_ref_json, source.form_api_version,
            source.form_kind, source.form_definition_version, source.schema_digest,
            source.package_digest, source.implementation_digest, source.publisher_key,
            source.policy_digest, source.policy_event_digest, source.checkpoint_sequence,
            source.checkpoint_digest, source.checkpoint_event_digest, source.source_commit,
            source.workflow_commit, source.repository_identifier, source.owner_identifier,
            source.namespace_group, source.namespace_grant_digest,
            source.admission_report_digest, source.admission_report_json,
            source.retention_ref, source.retention_until, 'purge-pending',
            source.event_digest, ?, ?, ?, ?, ?
         FROM ${INSTALL_TABLE} AS source
         CROSS JOIN (
           SELECT event_digest, package_digest, event_type
           FROM ${INSTALL_TABLE} AS current_install
           WHERE current_install.form_ref_key = ?
             AND NOT EXISTS (
               SELECT 1 FROM ${INSTALL_TABLE} AS successor_install
               WHERE successor_install.form_ref_key = current_install.form_ref_key
                 AND successor_install.predecessor_digest = current_install.event_digest
             )
           LIMIT 1
         ) AS install_head
         WHERE source.form_ref_key = ?
           AND source.package_digest = ?
           AND source.event_digest = ?
           AND source.event_type IN ('install', 'replace', 'uninstall')
           AND NOT (
             install_head.package_digest = source.package_digest
             AND install_head.event_type IN ('install', 'replace')
           )
           AND NOT EXISTS (SELECT 1 FROM purge_head)
           AND NOT EXISTS (
             SELECT 1 FROM tf_resources AS resource
             WHERE json_extract(resource.resource_json, '$.form.identity.packageDigest') = source.package_digest
                OR json_extract(resource.resource_json, '$.form.packageDigest') = source.package_digest
                OR json_extract(resource.resource_json, '$.packageDigest') = source.package_digest
           )
           AND NOT EXISTS (
             SELECT 1 FROM ${SUPPORT_TABLE} AS support
             WHERE support.package_digest = source.package_digest
               AND support.supported = 1
               AND NOT EXISTS (
                 SELECT 1 FROM ${SUPPORT_TABLE} AS successor
                 WHERE successor.support_key = support.support_key
                   AND successor.predecessor_digest = support.event_digest
               )
           )
           AND NOT EXISTS (
             SELECT 1 FROM ${ACTIVATION_TABLE} AS activation
             WHERE activation.package_digest = source.package_digest
               AND activation.active = 1
               AND NOT EXISTS (
                 SELECT 1 FROM ${ACTIVATION_TABLE} AS successor
                 WHERE successor.activation_key = activation.activation_key
                   AND successor.predecessor_digest = activation.event_digest
               )
           )
           AND NOT EXISTS (
             SELECT 1 FROM ${INSTALL_TABLE} AS retained
             WHERE retained.form_ref_key = source.form_ref_key
               AND retained.package_digest = source.package_digest
               AND retained.retention_ref IS NOT NULL
               AND (retained.retention_until IS NULL OR retained.retention_until > ?)
           )
           AND NOT EXISTS (
             SELECT 1 FROM ${EVACUATION_TABLE} AS evacuation
             WHERE evacuation.package_digest = source.package_digest
               AND evacuation.event_type = 'pending'
               AND NOT EXISTS (
                 SELECT 1 FROM ${EVACUATION_TABLE} AS successor
                 WHERE successor.resource_uid = evacuation.resource_uid
                   AND successor.predecessor_digest = evacuation.event_digest
               )
           )`,
        [
          formRefKey,
          command.packageDigest,
          id,
          command.actor,
          command.reason,
          eventAt,
          pendingDigest,
          predecessor,
          formRefKey,
          formRefKey,
          command.packageDigest,
          text(source.event_digest),
          eventAt,
        ],
      );
    } catch (error) {
      if (error instanceof SqlError && error.code === "constraint") {
        throw new AdmissionError(
          "admission_conflict",
          "package purge pending uniqueness fence rejected",
        );
      }
      throw error;
    }
    if (pending.changes !== 1) {
      const latest = await packagePurgeHead(sql, formRefKey, command.packageDigest);
      if (latest) {
        throw new AdmissionError("admission_conflict", "package purge predecessor moved");
      }
      throw new AdmissionError("package_references_exist", "package has live references");
    }
    current = await packagePurgeHead(sql, formRefKey, command.packageDigest);
  }

  if (!current || text(current.event_type) !== "purge-pending") {
    throw new AdmissionError("admission_conflict", "purge pending state disappeared");
  }
  // A crash after this delete and before the next INSERT leaves the durable
  // `purge-pending` row. Retrying this command is the forward repair path.
  try {
    await packages.purge(command.packageDigest);
  } catch (error) {
    throw packageError(error);
  }

  const predecessor = text(current.event_digest);
  const id = eventId(randomId);
  const eventAt = eventTime(command, clock);
  const eventDigest = await canonicalDigest({
    chain: "package-purge",
    id,
    eventType: "purged",
    sourceInstallEventDigest: text(current.source_install_event_digest),
    ...purgeEventMaterial(current),
    actor: command.actor,
    reason: command.reason,
    eventAt,
    predecessorDigest: predecessor,
  });
  const written = await guarded(
    sql.run(
      `INSERT INTO ${PURGE_TABLE}
         (id, form_ref_key, form_ref_json, form_api_version, form_kind,
          form_definition_version, schema_digest, package_digest,
          implementation_digest, publisher_key, policy_digest,
          policy_event_digest, checkpoint_sequence, checkpoint_digest,
          checkpoint_event_digest, source_commit, workflow_commit,
          repository_identifier, owner_identifier, namespace_group,
          namespace_grant_digest, admission_report_digest, admission_report_json,
          retention_ref, retention_until, event_type, source_install_event_digest,
          actor, reason, event_at, event_digest, predecessor_digest)
       SELECT ?, form_ref_key, form_ref_json, form_api_version, form_kind,
          form_definition_version, schema_digest, package_digest,
          implementation_digest, publisher_key, policy_digest,
          policy_event_digest, checkpoint_sequence, checkpoint_digest,
          checkpoint_event_digest, source_commit, workflow_commit,
          repository_identifier, owner_identifier, namespace_group,
          namespace_grant_digest, admission_report_digest, admission_report_json,
          retention_ref, retention_until, 'purged', source_install_event_digest,
          ?, ?, ?, ?, ?
       FROM ${PURGE_TABLE} AS current
       WHERE current.form_ref_key = ?
         AND current.package_digest = ?
         AND current.event_digest = ?
         AND current.event_type = 'purge-pending'
         AND NOT EXISTS (
           SELECT 1 FROM ${PURGE_TABLE} AS successor
           WHERE successor.form_ref_key = current.form_ref_key
             AND successor.package_digest = current.package_digest
             AND successor.predecessor_digest = current.event_digest
         )`,
      [
        id,
        command.actor,
        command.reason,
        eventAt,
        eventDigest,
        predecessor,
        formRefKey,
        command.packageDigest,
        predecessor,
      ],
    ),
    "package purged transition",
  );
  return {
    eventDigest,
    state: "purged",
    changed: written.changes === 1,
    packageDigest: command.packageDigest,
    formRef: structuredClone(command.formRef),
  };
}

async function executeSupport(
  sql: Sql,
  command: SetSupport,
  clock: Clock,
  randomId: () => string,
): Promise<AdmissionReceipt> {
  validateForm(command.formRef);
  validateDigest(command.packageDigest, "package digest");
  validateDigest(command.implementationDigest, "implementation digest");
  if (typeof command.supported !== "boolean") {
    throw new AdmissionError("invalid_command", "support state must be boolean");
  }
  requireJsonObject(command.profile, "support profile");
  if (
    !Array.isArray(command.operations) ||
    command.operations.some((value) => typeof value !== "string")
  ) {
    throw new AdmissionError("invalid_command", "support operations must be strings");
  }
  const formRefKey = await canonicalDigest(command.formRef);
  const supportKey = await canonicalDigest({ formRefKey, packageDigest: command.packageDigest });
  const current = await head(sql, SUPPORT_TABLE, "support_key", supportKey);
  const predecessor =
    command.predecessorDigest ?? (current ? text(current.event_digest) : ADMISSION_GENESIS_DIGEST);
  if (current && predecessor !== text(current.event_digest)) {
    throw new AdmissionError("admission_conflict", "support predecessor moved");
  }
  const id = eventId(randomId);
  const eventAt = eventTime(command, clock);
  const supported = command.supported ? 1 : 0;
  const profileJson = canonicalJson(command.profile);
  const operationsJson = canonicalJson(command.operations);
  const eventDigest = await canonicalDigest({
    chain: "support",
    id,
    supportKey,
    formRef: command.formRef,
    packageDigest: command.packageDigest,
    supported: command.supported,
    profile: command.profile,
    operations: command.operations,
    implementationDigest: command.implementationDigest,
    actor: command.actor,
    reason: command.reason,
    eventAt,
    predecessorDigest: predecessor,
  });
  const written = await guarded(
    sql.run(
      `WITH install_head AS (
         SELECT event_type, package_digest, publisher_key
         FROM ${INSTALL_TABLE} AS current
         WHERE current.form_ref_key = ?
           AND NOT EXISTS (
             SELECT 1 FROM ${INSTALL_TABLE} AS successor
             WHERE successor.form_ref_key = current.form_ref_key
               AND successor.predecessor_digest = current.event_digest
           )
         LIMIT 1
       ), publisher_head AS (
         SELECT event_type, event_digest
         FROM ${PUBLISHER_TABLE} AS current
         WHERE current.publisher_key = (SELECT publisher_key FROM install_head)
           AND NOT EXISTS (
             SELECT 1 FROM ${PUBLISHER_TABLE} AS successor
             WHERE successor.publisher_key = current.publisher_key
               AND successor.predecessor_digest = current.event_digest
           )
         LIMIT 1
       ), package_history AS (
         SELECT event_type
         FROM ${INSTALL_TABLE}
         WHERE form_ref_key = ?
           AND package_digest = ?
           AND event_type IN ('install', 'replace', 'uninstall')
         ORDER BY event_at DESC, id DESC
         LIMIT 1
       ), support_head AS (
         SELECT event_digest, supported, implementation_digest
         FROM ${SUPPORT_TABLE} AS current
         WHERE current.support_key = ?
           AND NOT EXISTS (
             SELECT 1 FROM ${SUPPORT_TABLE} AS successor
             WHERE successor.support_key = current.support_key
               AND successor.predecessor_digest = current.event_digest
           )
         LIMIT 1
       ), checkpoint_head AS (
         SELECT policy_event_digest, revoked_package_digests_json
         FROM ${CHECKPOINT_TABLE} AS current
         WHERE current.publisher_key = (SELECT publisher_key FROM install_head)
           AND NOT EXISTS (
             SELECT 1 FROM ${CHECKPOINT_TABLE} AS successor
             WHERE successor.publisher_key = current.publisher_key
               AND successor.predecessor_digest = current.event_digest
           )
         LIMIT 1
       )
       INSERT INTO ${SUPPORT_TABLE}
         (id, support_key, form_ref_key, form_ref_json, package_digest,
          supported, profile_json, operations_json, implementation_digest,
          actor, reason, event_at, event_digest, predecessor_digest)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
       WHERE (CASE WHEN ? = 1 THEN
               (SELECT package_digest FROM install_head) = ?
               AND (SELECT event_type FROM install_head) IN ('install', 'replace')
             ELSE
               (SELECT event_type FROM package_history) IN ('install', 'replace', 'uninstall')
             END)
         AND (CASE WHEN ? = 1 THEN
               (SELECT event_type FROM publisher_head) IN ('allow', 'rotate')
               AND (SELECT event_digest FROM publisher_head) = (SELECT policy_event_digest FROM checkpoint_head)
             ELSE 1 END)
         AND (CASE WHEN ? = 1 THEN NOT EXISTS (
           SELECT 1 FROM json_each(COALESCE((SELECT revoked_package_digests_json FROM checkpoint_head), '[]'))
           WHERE value = ?
         ) ELSE 1 END)
         AND (CASE WHEN ? = 0 THEN
               (SELECT supported FROM support_head) = 1
               AND (SELECT implementation_digest FROM support_head) = ?
             ELSE 1 END)
         AND COALESCE((SELECT event_digest FROM support_head), ?) = ?`,
      [
        formRefKey,
        formRefKey,
        command.packageDigest,
        supportKey,
        id,
        supportKey,
        formRefKey,
        canonicalJson(command.formRef),
        command.packageDigest,
        supported,
        profileJson,
        operationsJson,
        command.implementationDigest,
        command.actor,
        command.reason,
        eventAt,
        eventDigest,
        predecessor,
        supported,
        command.packageDigest,
        supported,
        supported,
        command.packageDigest,
        supported,
        command.implementationDigest,
        ADMISSION_GENESIS_DIGEST,
        predecessor,
      ],
    ),
    "support transition",
  );
  return {
    eventDigest,
    state: command.supported ? "supported" : "unsupported",
    changed: written.changes === 1,
    packageDigest: command.packageDigest,
    formRef: structuredClone(command.formRef),
  };
}

async function executeActivation(
  sql: Sql,
  command: SetActivation,
  clock: Clock,
  randomId: () => string,
): Promise<AdmissionReceipt> {
  validateForm(command.formRef);
  validateDigest(command.packageDigest, "package digest");
  if (typeof command.active !== "boolean") {
    throw new AdmissionError("invalid_command", "activation state must be boolean");
  }
  const audience = command.audience;
  if (
    !audience ||
    !["host", "tenant", "space", "principal"].includes(audience.kind) ||
    typeof audience.value !== "string" ||
    audience.value.length === 0 ||
    audience.value.length > 255
  ) {
    throw new AdmissionError(
      "invalid_command",
      "activation audience must be host|tenant|space|principal",
    );
  }
  validateDigest(command.implementationDigest, "implementation digest");
  const formRefKey = await canonicalDigest(command.formRef);
  const activationKey = await canonicalDigest({
    formRefKey,
    packageDigest: command.packageDigest,
    audience,
  });
  const current = await head(sql, ACTIVATION_TABLE, "activation_key", activationKey);
  const predecessor =
    command.predecessorDigest ?? (current ? text(current.event_digest) : ADMISSION_GENESIS_DIGEST);
  if (current && predecessor !== text(current.event_digest)) {
    throw new AdmissionError("admission_conflict", "activation predecessor moved");
  }
  const supportKey = await canonicalDigest({ formRefKey, packageDigest: command.packageDigest });
  const implementationDigest = command.implementationDigest;
  const id = eventId(randomId);
  const eventAt = eventTime(command, clock);
  const active = command.active ? 1 : 0;
  const eventDigest = await canonicalDigest({
    chain: "activation",
    id,
    activationKey,
    formRef: command.formRef,
    packageDigest: command.packageDigest,
    audience,
    active: command.active,
    implementationDigest,
    actor: command.actor,
    reason: command.reason,
    eventAt,
    predecessorDigest: predecessor,
  });
  const written = await guarded(
    sql.run(
      `WITH install_head AS (
         SELECT event_type, package_digest, publisher_key
         FROM ${INSTALL_TABLE} AS current
         WHERE current.form_ref_key = ?
           AND NOT EXISTS (
             SELECT 1 FROM ${INSTALL_TABLE} AS successor
             WHERE successor.form_ref_key = current.form_ref_key
               AND successor.predecessor_digest = current.event_digest
           )
         LIMIT 1
       ), support_head AS (
         SELECT supported, implementation_digest
         FROM ${SUPPORT_TABLE} AS current
         WHERE current.support_key = ?
           AND NOT EXISTS (
             SELECT 1 FROM ${SUPPORT_TABLE} AS successor
             WHERE successor.support_key = current.support_key
               AND successor.predecessor_digest = current.event_digest
           )
         LIMIT 1
       ), package_history AS (
         SELECT event_type
         FROM ${INSTALL_TABLE}
         WHERE form_ref_key = ?
           AND package_digest = ?
           AND event_type IN ('install', 'replace', 'uninstall')
         ORDER BY event_at DESC, id DESC
         LIMIT 1
       ), publisher_head AS (
         SELECT event_type, event_digest
         FROM ${PUBLISHER_TABLE} AS current
         WHERE current.publisher_key = (SELECT publisher_key FROM install_head)
           AND NOT EXISTS (
             SELECT 1 FROM ${PUBLISHER_TABLE} AS successor
             WHERE successor.publisher_key = current.publisher_key
               AND successor.predecessor_digest = current.event_digest
           )
         LIMIT 1
       ), checkpoint_head AS (
         SELECT policy_event_digest, revoked_package_digests_json
         FROM ${CHECKPOINT_TABLE} AS current
         WHERE current.publisher_key = (SELECT publisher_key FROM install_head)
           AND NOT EXISTS (
             SELECT 1 FROM ${CHECKPOINT_TABLE} AS successor
             WHERE successor.publisher_key = current.publisher_key
               AND successor.predecessor_digest = current.event_digest
           )
         LIMIT 1
       ), activation_head AS (
         SELECT event_digest, active, implementation_digest
         FROM ${ACTIVATION_TABLE} AS current
         WHERE current.activation_key = ?
           AND NOT EXISTS (
             SELECT 1 FROM ${ACTIVATION_TABLE} AS successor
             WHERE successor.activation_key = current.activation_key
               AND successor.predecessor_digest = current.event_digest
           )
         LIMIT 1
       )
       INSERT INTO ${ACTIVATION_TABLE}
         (id, activation_key, form_ref_key, form_ref_json, package_digest,
          audience_kind, audience_value, active, implementation_digest,
          actor, reason, event_at, event_digest, predecessor_digest)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
       WHERE (CASE WHEN ? = 1 THEN
               (SELECT package_digest FROM install_head) = ?
               AND (SELECT event_type FROM install_head) IN ('install', 'replace')
             ELSE
               (SELECT event_type FROM package_history) IN ('install', 'replace', 'uninstall')
             END)
         AND (CASE WHEN ? = 1 THEN (SELECT supported FROM support_head) = 1
                   AND (SELECT event_type FROM publisher_head) IN ('allow', 'rotate')
                   AND (SELECT event_digest FROM publisher_head) = (SELECT policy_event_digest FROM checkpoint_head)
                   AND (SELECT implementation_digest FROM support_head) = ?
                   AND NOT EXISTS (
                     SELECT 1 FROM json_each(COALESCE((SELECT revoked_package_digests_json FROM checkpoint_head), '[]'))
                     WHERE value = ?
                   )
                   ELSE 1 END)
         AND (CASE WHEN ? = 0 THEN
               (SELECT active FROM activation_head) = 1
               AND (SELECT implementation_digest FROM activation_head) = ?
             ELSE 1 END)
         AND COALESCE((SELECT event_digest FROM activation_head), ?) = ?`,
      [
        formRefKey,
        supportKey,
        formRefKey,
        command.packageDigest,
        activationKey,
        id,
        activationKey,
        formRefKey,
        canonicalJson(command.formRef),
        command.packageDigest,
        audience.kind,
        audience.value,
        active,
        implementationDigest,
        command.actor,
        command.reason,
        eventAt,
        eventDigest,
        predecessor,
        active,
        command.packageDigest,
        active,
        implementationDigest,
        command.packageDigest,
        active,
        implementationDigest,
        ADMISSION_GENESIS_DIGEST,
        predecessor,
      ],
    ),
    "activation transition",
  );
  return {
    eventDigest,
    state: command.active ? "active" : "inactive",
    changed: written.changes === 1,
    packageDigest: command.packageDigest,
    formRef: structuredClone(command.formRef),
  };
}

async function executeBeginEvacuation(
  sql: Sql,
  command: BeginEvacuation,
  clock: Clock,
  randomId: () => string,
): Promise<AdmissionReceipt> {
  validateForm(command.formRef);
  validateDigest(command.packageDigest, "package digest");
  validateDigest(command.implementationDigest, "implementation digest");
  requireText(command.resourceUid, "resource UID");
  requireText(command.claim, "evacuation claim");
  const formRefKey = await canonicalDigest(command.formRef);
  const current = await head(sql, EVACUATION_TABLE, "resource_uid", command.resourceUid);
  if (current)
    throw new AdmissionError("admission_conflict", "resource evacuation already has a successor");
  const predecessor = command.predecessorDigest ?? ADMISSION_GENESIS_DIGEST;
  const progress = command.progress ?? {};
  requireJsonObject(progress, "evacuation progress");
  const id = eventId(randomId);
  const eventAt = eventTime(command, clock);
  const eventDigest = await canonicalDigest({
    chain: "evacuation",
    id,
    resourceUid: command.resourceUid,
    formRef: command.formRef,
    packageDigest: command.packageDigest,
    implementationDigest: command.implementationDigest,
    eventType: "pending",
    claim: command.claim,
    progress,
    actor: command.actor,
    reason: command.reason,
    eventAt,
    predecessorDigest: predecessor,
  });
  const written = await guarded(
    sql.run(
      `WITH package_history AS (
         SELECT event_type
         FROM ${INSTALL_TABLE}
         WHERE form_ref_key = ?
           AND package_digest = ?
           AND event_type IN ('install', 'replace', 'uninstall')
         ORDER BY event_at DESC, id DESC
         LIMIT 1
       )
       INSERT INTO ${EVACUATION_TABLE}
         (id, resource_uid, form_ref_key, form_ref_json, package_digest,
          implementation_digest, event_type, claim, progress_json, receipt_json,
          actor, reason, event_at, event_digest, predecessor_digest)
       SELECT ?, ?, ?, ?, ?, ?, 'pending', ?, ?, NULL, ?, ?, ?, ?, ?
       WHERE (SELECT event_type FROM package_history) IN ('install', 'replace', 'uninstall')
         AND EXISTS (
           SELECT 1 FROM tf_resources AS resource
           WHERE resource.uid = ?
             AND json_extract(resource.resource_json, '$.form.identity.formRef.apiVersion') = ?
             AND json_extract(resource.resource_json, '$.form.identity.formRef.kind') = ?
             AND json_extract(resource.resource_json, '$.form.identity.formRef.definitionVersion') = ?
             AND json_extract(resource.resource_json, '$.form.identity.formRef.schemaDigest') = ?
             AND json_extract(resource.resource_json, '$.form.identity.packageDigest') = ?
             AND json_extract(resource.resource_json, '$.form.identity.implementationDigest') = ?
         )
         AND NOT EXISTS (
           SELECT 1 FROM ${EVACUATION_TABLE} WHERE resource_uid = ?
         )`,
      [
        formRefKey,
        command.packageDigest,
        id,
        command.resourceUid,
        formRefKey,
        canonicalJson(command.formRef),
        command.packageDigest,
        command.implementationDigest,
        command.claim,
        canonicalJson(progress),
        command.actor,
        command.reason,
        eventAt,
        eventDigest,
        predecessor,
        command.resourceUid,
        command.formRef.apiVersion,
        command.formRef.kind,
        command.formRef.definitionVersion,
        command.formRef.schemaDigest,
        command.packageDigest,
        command.implementationDigest,
        command.resourceUid,
      ],
    ),
    "evacuation begin transition",
  );
  return {
    eventDigest,
    state: "pending",
    changed: written.changes === 1,
    packageDigest: command.packageDigest,
    formRef: structuredClone(command.formRef),
  };
}

async function executeSettleEvacuation(
  sql: Sql,
  command: SettleEvacuation,
  clock: Clock,
  randomId: () => string,
): Promise<AdmissionReceipt> {
  requireText(command.resourceUid, "resource UID");
  if (command.state !== undefined && command.state !== "settled") {
    throw new AdmissionError("invalid_command", "evacuation settle state must be settled");
  }
  const current = await head(sql, EVACUATION_TABLE, "resource_uid", command.resourceUid);
  if (!current || text(current.event_type) !== "pending") {
    throw new AdmissionError("evacuation_pending", "no pending evacuation claim");
  }
  const receipt = command.receipt ?? {};
  const progress = command.progress ?? {};
  requireJsonObject(receipt, "evacuation receipt");
  requireJsonObject(progress, "evacuation progress");
  const sanitizedReceipt = sanitizeReceipt(receipt);
  const predecessor = command.predecessorDigest ?? text(current.event_digest);
  if (predecessor !== text(current.event_digest)) {
    throw new AdmissionError("admission_conflict", "evacuation predecessor moved");
  }
  const id = eventId(randomId);
  const eventAt = eventTime(command, clock);
  const eventDigest = await canonicalDigest({
    chain: "evacuation",
    id,
    resourceUid: command.resourceUid,
    formRef: JSON.parse(text(current.form_ref_json)),
    packageDigest: current.package_digest,
    implementationDigest: current.implementation_digest,
    eventType: "settled",
    claim: current.claim,
    progress,
    receipt: sanitizedReceipt,
    actor: command.actor,
    reason: command.reason,
    eventAt,
    predecessorDigest: predecessor,
  });
  const written = await guarded(
    sql.run(
      `INSERT INTO ${EVACUATION_TABLE}
         (id, resource_uid, form_ref_key, form_ref_json, package_digest,
          implementation_digest, event_type, claim, progress_json, receipt_json,
          actor, reason, event_at, event_digest, predecessor_digest)
       SELECT ?, resource_uid, form_ref_key, form_ref_json, package_digest,
          implementation_digest, 'settled', claim, ?, ?, ?, ?, ?, ?, ?
       FROM ${EVACUATION_TABLE} AS current
       WHERE current.resource_uid = ?
         AND current.event_digest = ?
         AND current.event_type = 'pending'
         AND NOT EXISTS (
           SELECT 1 FROM ${EVACUATION_TABLE} AS successor
           WHERE successor.resource_uid = current.resource_uid
             AND successor.predecessor_digest = current.event_digest
         )`,
      [
        id,
        canonicalJson(progress),
        JSON.stringify(sanitizedReceipt),
        command.actor,
        command.reason,
        eventAt,
        eventDigest,
        predecessor,
        command.resourceUid,
        predecessor,
      ],
    ),
    "evacuation settle transition",
  );
  return { eventDigest, state: "settled", changed: written.changes === 1 };
}

async function inspectAdmission(
  sql: Sql,
  query: AdmissionQuery,
  _clock: Clock,
): Promise<import("./admission.ts").AdmissionView> {
  if (!query || typeof query !== "object") {
    throw new AdmissionError("invalid_command", "query must be an object");
  }
  if (query.kind !== undefined && query.type !== undefined && query.kind !== query.type) {
    throw new AdmissionError("invalid_command", "query kind and type disagree");
  }
  const kind = query.kind ?? query.type;
  if (!kind) throw new AdmissionError("invalid_command", "query kind is required");
  const limit = query.limit === undefined ? 100 : query.limit;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
    throw new AdmissionError("invalid_command", "query limit is invalid");
  }
  if (kind === "Publisher") {
    requireText(query.publisherKey, "publisher key");
    const publisher = await head(sql, PUBLISHER_TABLE, "publisher_key", query.publisherKey);
    const checkpoint = await head(sql, CHECKPOINT_TABLE, "publisher_key", query.publisherKey);
    return {
      kind,
      publisher: publisher ? rowView(publisher) : null,
      checkpoint: checkpoint ? rowView(checkpoint) : null,
    };
  }
  if (kind === "Checkpoint") {
    requireText(query.publisherKey, "publisher key");
    const rows = await sql.query(
      `SELECT * FROM ${CHECKPOINT_TABLE} WHERE publisher_key = ? ORDER BY sequence LIMIT ?`,
      [query.publisherKey, limit],
    );
    return { kind, events: rows.map(rowView) };
  }
  if (kind === "Package" || kind === "Support" || kind === "Activation") {
    if (!query.formRef || !query.packageDigest) {
      throw new AdmissionError("invalid_command", "package query needs FormRef and package digest");
    }
    validateForm(query.formRef);
    validateDigest(query.packageDigest, "package digest");
    const formRefKey = await canonicalDigest(query.formRef);
    const install = await head(sql, INSTALL_TABLE, "form_ref_key", formRefKey);
    const supportKey = await canonicalDigest({ formRefKey, packageDigest: query.packageDigest });
    const support = await head(sql, SUPPORT_TABLE, "support_key", supportKey);
    const activationRows = await sql.query(
      `SELECT * FROM ${ACTIVATION_TABLE}
       WHERE form_ref_key = ? AND package_digest = ?
       ORDER BY event_at, id LIMIT ?`,
      [formRefKey, query.packageDigest, limit],
    );
    if (kind === "Support") return { kind, support: support ? rowView(support) : null };
    if (kind === "Activation") return { kind, activations: activationRows.map(rowView) };
    return {
      kind,
      install:
        install && text(install.package_digest) === query.packageDigest ? rowView(install) : null,
      support:
        support && text(support.package_digest) === query.packageDigest ? rowView(support) : null,
      activations: activationRows.map(rowView),
    };
  }
  if (kind === "Evacuation") {
    requireText(query.resourceUid, "resource UID");
    const evacuation = await head(sql, EVACUATION_TABLE, "resource_uid", query.resourceUid);
    return { kind, evacuation: evacuation ? rowView(evacuation) : null };
  }
  if (kind === "History") {
    const chain = query.chain;
    const table =
      chain === "publisher"
        ? PUBLISHER_TABLE
        : chain === "checkpoint"
          ? CHECKPOINT_TABLE
          : chain === "install"
            ? INSTALL_TABLE
            : chain === "purge"
              ? PURGE_TABLE
              : chain === "support"
                ? SUPPORT_TABLE
                : chain === "activation"
                  ? ACTIVATION_TABLE
                  : chain === "evacuation"
                    ? EVACUATION_TABLE
                    : null;
    if (!table) throw new AdmissionError("invalid_command", "history chain is invalid");
    const rows = await sql.query(`SELECT * FROM ${table} ORDER BY event_at, id LIMIT ?`, [limit]);
    return { kind, events: rows.map(rowView) };
  }
  throw new AdmissionError("invalid_command", `unknown admission query: ${kind}`);
}

function assertHandleForCommand(
  claims: AdmissionHandleClaims,
  command: InstallPackage | ReplacePackage,
  operation: "install" | "replace",
): void {
  if (claims.operation !== operation)
    throw new AdmissionError("handle_mismatch", "handle operation mismatch");
  if (claims.packageDigest !== command.package.packageDigest) {
    throw new AdmissionError("handle_mismatch", "handle package digest mismatch");
  }
  if (canonicalJson(claims.formRef) !== canonicalJson(command.package.formRef)) {
    throw new AdmissionError("handle_mismatch", "handle FormRef mismatch");
  }
  const formGroup = claims.formRef.apiVersion.slice(0, claims.formRef.apiVersion.indexOf("/"));
  if (claims.publisher.group !== formGroup) {
    throw new AdmissionError("handle_mismatch", "publisher namespace does not match Form group");
  }
  if (claims.report.status !== "admitted") {
    throw new AdmissionError("invalid_handle", "the Core report did not admit the package");
  }
}

async function ensurePackage(
  packages: FormPackageStore,
  input: FormPackageInput,
): Promise<StoredFormPackage> {
  if (Array.isArray(input.files) && input.files.length > 0) return packages.put(input);
  const existing = await packages.read({
    packageDigest: input.packageDigest,
    formRef: input.formRef,
  });
  if (!existing) throw new AdmissionError("package_invalid", "package bytes are missing");
  return existing;
}

function normalizePublisher(input: AdmissionPublisherPin): AdmissionPublisherPin {
  if (!input || typeof input !== "object")
    throw new AdmissionError("invalid_command", "publisher pin is required");
  const allowed = new Set([
    "publisherKey",
    "policyDigest",
    "policy",
    "oidcIssuer",
    "sourceRepository",
    "workflow",
    "ref",
    "identity",
    "trustedRootDigest",
    "sourceCommit",
    "workflowCommit",
    "repositoryIdentifier",
    "ownerIdentifier",
    "group",
    "namespaceGrantDigest",
  ]);
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) {
      throw new AdmissionError("invalid_command", `publisher pin field ${key} is not allowed`);
    }
  }
  validateDigest(input.policyDigest, "policy digest");
  validateDigest(input.namespaceGrantDigest, "namespace grant digest");
  validateDigest(input.trustedRootDigest, "trusted root digest");
  for (const [name, value] of Object.entries(input)) {
    if (name !== "policy" && (typeof value !== "string" || value.length === 0)) {
      throw new AdmissionError("invalid_command", `publisher pin field ${name} is invalid`);
    }
  }
  if (input.policy !== undefined) {
    requireJsonObject(input.policy, "publisher policy");
    if (hasReservedAdmissionField(input.policy)) {
      throw new AdmissionError("invalid_command", "publisher policy has a reserved field");
    }
  }
  if (input.publisherKey !== undefined) requireText(input.publisherKey, "publisher key");
  requireText(input.group, "publisher namespace group");
  if (!isFormGroup(input.group)) {
    throw new AdmissionError("invalid_command", "publisher namespace group is invalid");
  }
  return structuredClone(input);
}

function hasReservedAdmissionField(value: Record<string, unknown>): boolean {
  return Object.hasOwn(value, "official") || Object.hasOwn(value, "lane");
}

async function publisherKeyOf(publisher: AdmissionPublisherPin): Promise<string> {
  if (publisher.publisherKey) return publisher.publisherKey;
  return canonicalDigest({
    sourceRepository: publisher.sourceRepository,
    repositoryIdentifier: publisher.repositoryIdentifier,
    ownerIdentifier: publisher.ownerIdentifier,
  });
}

function installEventMaterial(row: Row): Record<string, unknown> {
  return {
    formRef: JSON.parse(text(row.form_ref_json)),
    packageDigest: text(row.package_digest),
    replacesPackageDigest:
      row.replaces_package_digest === null ? null : text(row.replaces_package_digest),
    admissionReportDigest: text(row.admission_report_digest),
    admissionReport: JSON.parse(text(row.admission_report_json)),
    publisherKey: text(row.publisher_key),
    policyDigest: text(row.policy_digest),
    policyEventDigest: text(row.policy_event_digest),
    checkpointSequence: Number(row.checkpoint_sequence),
    checkpointDigest: text(row.checkpoint_digest),
    checkpointEventDigest: text(row.checkpoint_event_digest),
    sourceCommit: text(row.source_commit),
    workflowCommit: text(row.workflow_commit),
    repositoryIdentifier: text(row.repository_identifier),
    ownerIdentifier: text(row.owner_identifier),
    namespaceGroup: text(row.namespace_group),
    namespaceGrantDigest: text(row.namespace_grant_digest),
    implementationDigest:
      row.implementation_digest === null ? null : text(row.implementation_digest),
    retentionRef: row.retention_ref === null ? null : text(row.retention_ref),
    retentionUntil: row.retention_until === null ? null : Number(row.retention_until),
  };
}

function purgeEventMaterial(row: Row): Record<string, unknown> {
  return {
    formRef: JSON.parse(text(row.form_ref_json)),
    packageDigest: text(row.package_digest),
    implementationDigest:
      row.implementation_digest === null ? null : text(row.implementation_digest),
    publisherKey: text(row.publisher_key),
    policyDigest: text(row.policy_digest),
    policyEventDigest: text(row.policy_event_digest),
    checkpointSequence: Number(row.checkpoint_sequence),
    checkpointDigest: text(row.checkpoint_digest),
    checkpointEventDigest: text(row.checkpoint_event_digest),
    sourceCommit: text(row.source_commit),
    workflowCommit: text(row.workflow_commit),
    repositoryIdentifier: text(row.repository_identifier),
    ownerIdentifier: text(row.owner_identifier),
    namespaceGroup: text(row.namespace_group),
    namespaceGrantDigest: text(row.namespace_grant_digest),
    admissionReportDigest: text(row.admission_report_digest),
    admissionReport: JSON.parse(text(row.admission_report_json)),
    retentionRef: row.retention_ref === null ? null : text(row.retention_ref),
    retentionUntil: row.retention_until === null ? null : Number(row.retention_until),
  };
}

async function packageInstallSource(
  sql: Sql,
  formRefKey: string,
  packageDigest: AdmissionDigest,
): Promise<Row | null> {
  const rows = await sql.query(
    `SELECT * FROM ${INSTALL_TABLE}
     WHERE form_ref_key = ?
       AND package_digest = ?
       AND event_type IN ('install', 'replace', 'uninstall')
     ORDER BY event_at DESC, id DESC
     LIMIT 1`,
    [formRefKey, packageDigest],
  );
  return rows[0] ?? null;
}

async function packagePurgeHead(
  sql: Sql,
  formRefKey: string,
  packageDigest: AdmissionDigest,
): Promise<Row | null> {
  const rows = await sql.query(
    `SELECT * FROM ${PURGE_TABLE} AS current
     WHERE current.form_ref_key = ?
       AND current.package_digest = ?
       AND NOT EXISTS (
         SELECT 1 FROM ${PURGE_TABLE} AS successor
         WHERE successor.form_ref_key = current.form_ref_key
           AND successor.package_digest = current.package_digest
           AND successor.predecessor_digest = current.event_digest
       )
     LIMIT 2`,
    [formRefKey, packageDigest],
  );
  return rows[0] ?? null;
}

/**
 * An install writes bytes before its guarded event CAS. If a purge lifecycle
 * wins that CAS race, the bytes are no longer installable and must be
 * collected. Re-read the lifecycle and all current install heads immediately
 * before deletion so a successful concurrent install keeps its content.
 */
async function repairRejectedInstallPackageBytes(
  sql: Sql,
  packages: FormPackageStore,
  formRef: FormPackageInput["formRef"],
  formRefKey: string,
  packageDigest: AdmissionDigest,
  eventDigest: AdmissionDigest,
): Promise<void> {
  if (!(await packagePurgeHead(sql, formRefKey, packageDigest))) return;
  // A null read can mean an incomplete or malformed prefix, not proof that no
  // bytes exist.  Sweep the entire content-addressed prefix once the durable
  // lifecycle and install heads say it is no longer owned.
  await packages.read({ packageDigest, formRef });
  const ownEvent = await sql.query(
    `SELECT 1
     FROM ${INSTALL_TABLE}
     WHERE form_ref_key = ?
       AND event_digest = ?
     LIMIT 1`,
    [formRefKey, eventDigest],
  );
  if (ownEvent.length > 0 || (await hasCurrentInstallForPackage(sql, packageDigest))) return;

  // The lifecycle is append-only, but re-read it after checking install heads
  // to close the race with a purge that was committed between those reads.
  if (!(await packagePurgeHead(sql, formRefKey, packageDigest))) return;
  const installedAfterRecheck = await sql.query(
    `SELECT 1
     FROM ${INSTALL_TABLE}
     WHERE form_ref_key = ?
       AND event_digest = ?
     LIMIT 1`,
    [formRefKey, eventDigest],
  );
  if (installedAfterRecheck.length > 0 || (await hasCurrentInstallForPackage(sql, packageDigest))) {
    return;
  }
  await packages.read({ packageDigest, formRef });
  await purgeAndVerifyPackageBytes(packages, formRef, packageDigest);
}

/**
 * A terminal purge is durable truth. Retrying it also repairs any bytes left
 * by a failed cleanup; otherwise the terminal head would make the object
 * prefix permanently unreachable through the normal PurgePackage command.
 */
async function repairPurgedPackageBytes(
  sql: Sql,
  packages: FormPackageStore,
  formRef: FormPackageInput["formRef"],
  packageDigest: AdmissionDigest,
): Promise<void> {
  if (await hasCurrentInstallForPackage(sql, packageDigest)) {
    throw new AdmissionError(
      "admission_conflict",
      "cannot repair purged package bytes while the package is installed",
    );
  }
  await purgeAndVerifyPackageBytes(packages, formRef, packageDigest);
}

async function hasCurrentInstallForPackage(
  sql: Sql,
  packageDigest: AdmissionDigest,
): Promise<boolean> {
  const rows = await sql.query(
    `SELECT 1
     FROM ${INSTALL_TABLE} AS current
     WHERE current.package_digest = ?
       AND current.event_type IN ('install', 'replace')
       AND NOT EXISTS (
         SELECT 1 FROM ${INSTALL_TABLE} AS successor
         WHERE successor.form_ref_key = current.form_ref_key
           AND successor.predecessor_digest = current.event_digest
       )
     LIMIT 1`,
    [packageDigest],
  );
  return rows.length > 0;
}

async function purgeAndVerifyPackageBytes(
  packages: FormPackageStore,
  formRef: FormPackageInput["formRef"],
  packageDigest: AdmissionDigest,
): Promise<void> {
  try {
    await packages.purge(packageDigest);
    const remaining = await packages.read({ packageDigest, formRef });
    if (remaining) {
      throw new AdmissionError("package_store_unavailable", "package bytes remain after purge");
    }
  } catch (error) {
    throw packageCleanupError(error);
  }
}

async function head(sql: Sql, table: string, keyColumn: string, key: string): Promise<Row | null> {
  const rows = await sql.query(
    `SELECT * FROM ${table} AS current
     WHERE current.${keyColumn} = ?
       AND NOT EXISTS (
         SELECT 1 FROM ${table} AS successor
         WHERE successor.${keyColumn} = current.${keyColumn}
           AND successor.predecessor_digest = current.event_digest
       )
     LIMIT 2`,
    [key],
  );
  return rows[0] ?? null;
}

function packageCleanupError(error: unknown): AdmissionError {
  if (error instanceof AdmissionError) return error;
  if (error instanceof ObjectStoreError && error.code === "unavailable") {
    return new AdmissionError("package_store_unavailable", error.message);
  }
  const packageError = error as Partial<FormPackageError>;
  if (packageError.code === "package_store_unavailable") {
    return new AdmissionError(
      "package_store_unavailable",
      String(packageError.message ?? packageError.code),
    );
  }
  return new AdmissionError(
    "package_store_unavailable",
    `package bytes could not be cleaned up: ${String(packageError.message ?? error)}`,
  );
}

async function guarded(write: Promise<SqlWrite>, operation: string): Promise<SqlWrite> {
  try {
    const result = await write;
    if (result.changes !== 1)
      throw new AdmissionError("admission_conflict", `${operation} guard rejected`);
    return result;
  } catch (error) {
    if (error instanceof AdmissionError) throw error;
    if (error instanceof SqlError && error.code === "constraint") {
      throw new AdmissionError("admission_conflict", `${operation} uniqueness fence rejected`);
    }
    throw error;
  }
}

function packageError(error: unknown): AdmissionError {
  if (error instanceof AdmissionError) return error;
  if (error instanceof ObjectStoreError && error.code === "unavailable") {
    return new AdmissionError("package_store_unavailable", error.message);
  }
  const packageError = error as Partial<FormPackageError>;
  if (packageError.code === "package_store_unavailable") {
    return new AdmissionError(
      "package_store_unavailable",
      String(packageError.message ?? packageError.code),
    );
  }
  return new AdmissionError("package_invalid", String(packageError.message ?? error));
}

function eventId(randomId: () => string): string {
  const value = randomId().replace(/[^A-Za-z0-9._:-]/gu, "");
  if (value.length < 3 || value.length > 255)
    throw new AdmissionError("invalid_command", "event id generator returned an invalid value");
  return value;
}

function eventTime(command: AdmissionCommandMetadata, clock: Clock): number {
  const value = command.eventAt ?? command.timestamp ?? clock().getTime();
  if (!Number.isSafeInteger(value) || value < 0)
    throw new AdmissionError("invalid_command", "event timestamp is invalid");
  requireText(command.actor, "event actor");
  requireText(command.reason, "event reason");
  return value;
}

function requireText(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 4_096) {
    throw new AdmissionError("invalid_command", `${label} must be a bounded non-empty string`);
  }
}

function requireInteger(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value))
    throw new AdmissionError("invalid_command", `${label} must be an integer`);
}

function requireJsonObject(
  value: unknown,
  label: string,
): asserts value is Record<string, unknown> {
  if (!isJsonObject(value))
    throw new AdmissionError("invalid_command", `${label} must be a JSON object`);
}

function validateForm(formRef: import("../form-ref.ts").TakoformV1Alpha3FormRef): void {
  try {
    validateFormRef(formRef as import("../form-ref.ts").TakoformV1Alpha3FormRef);
  } catch {
    throw new AdmissionError("invalid_command", "invalid FormRef");
  }
}

function sanitizeReceipt(value: Record<string, unknown>): Record<string, unknown> {
  const json = canonicalJson(value);
  if (json.length > 65_536)
    throw new AdmissionError("invalid_command", "evacuation receipt is too large");
  return sanitizeValue(value) as Record<string, unknown>;
}

function sanitizeValue(value: unknown): unknown {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    typeof value === "number"
  )
    return value;
  if (Array.isArray(value)) return value.map(sanitizeValue);
  if (!isJsonObject(value))
    throw new AdmissionError("invalid_command", "receipt contains non-JSON data");
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (/(?:token|secret|credential|password|private|authorization)/iu.test(key)) {
      throw new AdmissionError("invalid_command", "receipt contains sensitive field");
    }
    out[key] = sanitizeValue(child);
  }
  return out;
}

function rowView(row: Row): Record<string, unknown> {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, value]));
}

function text(value: unknown): string {
  if (typeof value !== "string")
    throw new AdmissionError("invalid_command", "malformed durable admission row");
  return value;
}

function digestOf(_predecessor: unknown, eventDigest: unknown): AdmissionDigest {
  const value = text(eventDigest);
  if (!isSha256Digest(value))
    throw new AdmissionError("invalid_command", "malformed durable digest");
  return value;
}
