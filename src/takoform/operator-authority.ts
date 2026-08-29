import { canonicalDigest, canonicalJson, isSha256Digest } from "../json.ts";
import type { JsonObject } from "../ports.ts";
import type {
  AdmissionCommand,
  AdmissionDigest,
  AdmissionReceipt,
  FormAdmissionHost,
} from "./admission.ts";
import { ADMISSION_GENESIS_DIGEST } from "./admission.ts";
import type {
  CoreAdmissionAdapter,
  FormAuthorityEnvironment,
  FormAuthorityTrustEvidence,
  PreparedCoreAdmission,
  SignedTrustEvidenceAdapter,
} from "./core-admission-adapter.ts";
import type { FormPackageInput, FormPackageStore } from "./form-packages.ts";
import { takoformActivationAudience } from "./host-authority.ts";
import type {
  TakoformImplementationCatalog,
  TakoformImplementationCatalogEntry,
} from "./implementation-catalog.ts";

export interface FormAuthorityIdentity {
  readonly environment: FormAuthorityEnvironment;
  readonly hostId: string;
  readonly workerArtifactDigest: AdmissionDigest;
  readonly publicWorkerVersionId: string;
  readonly capabilityDigest: AdmissionDigest;
  readonly implementationDigest: AdmissionDigest;
}

export interface FormAuthorityPlanRequest extends FormAuthorityIdentity {
  readonly kind: "takoserver.form-authority-plan-request@v1";
  readonly activation: {
    readonly kind: "space";
    readonly tenantId: string;
    readonly space: string;
  };
  readonly evidence: FormAuthorityTrustEvidence;
  readonly actor: string;
  readonly reason: string;
}

export interface FormAuthorityHead {
  readonly kind: "publisher" | "checkpoint" | "package" | "install" | "support" | "activation";
  readonly key: string;
  readonly eventDigest: AdmissionDigest | null;
}

interface FormAuthorityCommandBase {
  readonly index: number;
  readonly commandDigest: AdmissionDigest;
  readonly predecessorDigest: AdmissionDigest;
}

export type FormAuthorityCommand = FormAuthorityCommandBase &
  (
    | { readonly kind: "AllowPublisher" }
    | { readonly kind: "AppendCheckpoint" }
    | {
        readonly kind: "InstallPackage" | "ReplacePackage";
        readonly formRef: TakoformImplementationCatalogEntry["formRef"];
        readonly packageDigest: AdmissionDigest;
      }
    | {
        readonly kind: "SetSupport";
        readonly formRef: TakoformImplementationCatalogEntry["formRef"];
        readonly packageDigest: AdmissionDigest;
        readonly operations: TakoformImplementationCatalogEntry["operations"];
      }
    | {
        readonly kind: "SetActivation";
        readonly formRef: TakoformImplementationCatalogEntry["formRef"];
        readonly packageDigest: AdmissionDigest;
        readonly audience: { readonly kind: "space"; readonly value: string };
      }
  );

type FormAuthorityCommandDescriptor<T = FormAuthorityCommand> = T extends FormAuthorityCommand
  ? Omit<T, "index" | "commandDigest">
  : never;

export interface FormAuthorityPlan {
  readonly kind: "takoserver.form-authority-plan@v1";
  readonly request: FormAuthorityPlanRequest;
  readonly packages: readonly {
    readonly formRef: TakoformImplementationCatalogEntry["formRef"];
    readonly schemaDigest: AdmissionDigest;
    readonly packageDigest: AdmissionDigest;
    readonly operations: TakoformImplementationCatalogEntry["operations"];
  }[];
  readonly currentHeads: readonly FormAuthorityHead[];
  readonly currentHeadDigest: AdmissionDigest;
  readonly commands: readonly FormAuthorityCommand[];
  readonly planDigest: AdmissionDigest;
}

export interface FormAuthorityReadback {
  readonly kind: "takoserver.form-authority-readback@v1";
  readonly identity: FormAuthorityIdentity;
  readonly activation: FormAuthorityPlanRequest["activation"];
  readonly currentHeads: readonly FormAuthorityHead[];
  readonly currentHeadDigest: AdmissionDigest;
  readonly forms: readonly {
    readonly formRef: TakoformImplementationCatalogEntry["formRef"];
    readonly packageDigest: AdmissionDigest;
    readonly operations: TakoformImplementationCatalogEntry["operations"];
    readonly installed: boolean;
    readonly supported: boolean;
    readonly active: boolean;
  }[];
}

export interface FormAuthorityActionReceipt {
  readonly index: number;
  readonly commandDigest: AdmissionDigest;
  readonly kind: FormAuthorityCommand["kind"];
  readonly eventDigest: AdmissionDigest;
  readonly state: AdmissionReceipt["state"];
  readonly changed: boolean;
  readonly admissionMode: "released-core" | "integration-fixture";
  readonly productionEligible: boolean;
}

export interface FormAuthorityApplyResult {
  readonly kind: "takoserver.form-authority-apply@v1";
  readonly status: "converged" | "partial";
  readonly planDigest: AdmissionDigest;
  readonly receipts: readonly FormAuthorityActionReceipt[];
  readonly admissionMode: "released-core" | "integration-fixture";
  readonly productionEligible: boolean;
  readonly readback: FormAuthorityReadback;
  readonly nextPlan: FormAuthorityPlan;
  readonly replanRequired: boolean;
  readonly failure?: {
    readonly index: number;
    readonly commandDigest: AdmissionDigest;
    readonly code: string;
  };
}

export interface FormAuthorityPackageSource {
  load(input: {
    readonly formRef: TakoformImplementationCatalogEntry["formRef"];
    readonly packageDigest: AdmissionDigest;
  }): Promise<FormPackageInput>;
}

export interface FormAuthorityOperator {
  plan(request: FormAuthorityPlanRequest): Promise<FormAuthorityPlan>;
  apply(plan: FormAuthorityPlan): Promise<FormAuthorityApplyResult>;
  readback(request: FormAuthorityPlanRequest): Promise<FormAuthorityReadback>;
}

export class FormAuthorityOperatorError extends Error {
  constructor(
    readonly code:
      | "invalid_request"
      | "identity_mismatch"
      | "plan_digest_mismatch"
      | "head_drift"
      | "production_not_ready"
      | "authority_state_conflict"
      | "history_too_large"
      | "package_unavailable",
    message: string = code,
  ) {
    super(message);
    this.name = "FormAuthorityOperatorError";
  }
}

interface AuthorityState {
  readonly heads: readonly FormAuthorityHead[];
  readonly headDigest: AdmissionDigest;
  readonly publisher: AuthorityRow | null;
  readonly checkpoint: AuthorityRow | null;
  readonly forms: readonly {
    readonly entry: TakoformImplementationCatalogEntry;
    readonly install: AuthorityRow | null;
    readonly support: AuthorityRow | null;
    readonly activation: AuthorityRow | null;
    readonly packagePresent: boolean;
    readonly installCurrent: boolean;
  }[];
}

type AuthorityRow = Readonly<Record<string, unknown>>;

export function createFormAuthorityOperator(options: {
  readonly identity: FormAuthorityIdentity;
  readonly catalog: TakoformImplementationCatalog;
  readonly packages: FormAuthorityPackageSource;
  /** Exact R2 package closure shared with the admission store. */
  readonly storedPackages: Pick<FormPackageStore, "read">;
  readonly admission: FormAdmissionHost;
  readonly core: CoreAdmissionAdapter;
  readonly trust: SignedTrustEvidenceAdapter;
  /** Rechecks the live public Host immediately before every durable command. */
  readonly assertMutationAuthority: () => Promise<void>;
}): FormAuthorityOperator {
  validateIdentity(options.identity);
  if (
    options.catalog.capabilityDigest !== options.identity.capabilityDigest ||
    options.catalog.implementationDigest !== options.identity.implementationDigest
  ) {
    throw new FormAuthorityOperatorError(
      "identity_mismatch",
      "implementation catalog digests do not match the Worker identity",
    );
  }
  const entries = [...options.catalog.entries].sort((left, right) =>
    canonicalJson(left.formRef).localeCompare(canonicalJson(right.formRef)),
  );

  const readState = async (request: FormAuthorityPlanRequest): Promise<AuthorityState> => {
    assertRequestIdentity(request, options.identity);
    const [publishers, checkpoints, installs, supports, activations] = await Promise.all([
      history(options.admission, "publisher"),
      history(options.admission, "checkpoint"),
      history(options.admission, "install"),
      history(options.admission, "support"),
      history(options.admission, "activation"),
    ]);
    const publisher = exactHead(
      publishers.filter((row) => row.publisher_key === request.evidence.publisher.publisherKey),
      "publisher_key",
    );
    const checkpoint = exactHead(
      checkpoints.filter(
        (row) =>
          row.publisher_key === request.evidence.publisher.publisherKey &&
          row.checkpoint_api_version === request.evidence.checkpoint.apiVersion,
      ),
      "publisher_key",
    );
    const audience = spaceAudience(request.activation);
    const forms = await Promise.all(
      entries.map(async (entry) => {
        const formRefKey = await canonicalDigest(entry.formRef);
        const supportKey = await canonicalDigest({
          formRefKey,
          packageDigest: entry.packageDigest,
        });
        const activationKey = await canonicalDigest({
          formRefKey,
          packageDigest: entry.packageDigest,
          audience,
        });
        const install = exactHead(
          installs.filter((row) => row.form_ref_key === formRefKey),
          "form_ref_key",
        );
        const packagePresent =
          (await options.storedPackages.read({
            packageDigest: entry.packageDigest,
            formRef: entry.formRef,
          })) !== null;
        return {
          entry,
          install,
          support: exactHead(
            supports.filter((row) => row.support_key === supportKey),
            "support_key",
          ),
          activation: exactHead(
            activations.filter((row) => row.activation_key === activationKey),
            "activation_key",
          ),
          packagePresent,
          installCurrent:
            packagePresent && (await installMatches(install, entry, request.evidence)),
        };
      }),
    );
    const heads: FormAuthorityHead[] = [
      head("publisher", request.evidence.publisher.publisherKey, publisher),
      head(
        "checkpoint",
        `${request.evidence.publisher.publisherKey}\0${request.evidence.checkpoint.apiVersion}`,
        checkpoint,
      ),
    ];
    for (const form of forms) {
      const formKey = canonicalJson(form.entry.formRef);
      heads.push(
        {
          kind: "package",
          key: formKey,
          eventDigest: form.packagePresent ? form.entry.packageDigest : null,
        },
        head("install", formKey, form.install),
        head("support", `${formKey}\0${form.entry.packageDigest}`, form.support),
        head(
          "activation",
          `${formKey}\0${form.entry.packageDigest}\0${audience.value}`,
          form.activation,
        ),
      );
    }
    heads.sort((left, right) =>
      `${left.kind}\0${left.key}`.localeCompare(`${right.kind}\0${right.key}`),
    );
    return {
      heads,
      headDigest: await canonicalDigest(heads),
      publisher,
      checkpoint,
      forms,
    };
  };

  const readback = async (request: FormAuthorityPlanRequest): Promise<FormAuthorityReadback> => {
    const state = await readState(request);
    return {
      kind: "takoserver.form-authority-readback@v1",
      identity: structuredClone(options.identity),
      activation: structuredClone(request.activation),
      currentHeads: structuredClone(state.heads),
      currentHeadDigest: state.headDigest,
      forms: state.forms.map(({ entry, support, activation, installCurrent }) => {
        const installed = installCurrent;
        return {
          formRef: structuredClone(entry.formRef),
          packageDigest: entry.packageDigest,
          operations: [...entry.operations],
          installed,
          supported:
            installed && supportMatches(support, entry, options.identity.implementationDigest),
          active: installed && activationMatches(activation, options.identity.implementationDigest),
        };
      }),
    };
  };

  const buildPlan = async (
    request: FormAuthorityPlanRequest,
    state: AuthorityState,
  ): Promise<FormAuthorityPlan> => {
    assertExistingAuthorityMatches(request, state);
    const descriptors: FormAuthorityCommandDescriptor[] = [];
    if (!state.publisher) {
      descriptors.push({ kind: "AllowPublisher", predecessorDigest: ADMISSION_GENESIS_DIGEST });
    }
    if (!state.checkpoint) {
      descriptors.push({ kind: "AppendCheckpoint", predecessorDigest: ADMISSION_GENESIS_DIGEST });
    }
    const audience = spaceAudience(request.activation);
    for (const { entry, install, support, activation, installCurrent } of state.forms) {
      if (!installCurrent) {
        descriptors.push({
          kind: install ? "ReplacePackage" : "InstallPackage",
          formRef: structuredClone(entry.formRef),
          packageDigest: entry.packageDigest,
          predecessorDigest: eventDigest(install) ?? ADMISSION_GENESIS_DIGEST,
        });
      }
      if (!supportMatches(support, entry, options.identity.implementationDigest)) {
        descriptors.push({
          kind: "SetSupport",
          formRef: structuredClone(entry.formRef),
          packageDigest: entry.packageDigest,
          operations: [...entry.operations],
          predecessorDigest: eventDigest(support) ?? ADMISSION_GENESIS_DIGEST,
        });
      }
      if (!activationMatches(activation, options.identity.implementationDigest)) {
        descriptors.push({
          kind: "SetActivation",
          formRef: structuredClone(entry.formRef),
          packageDigest: entry.packageDigest,
          audience,
          predecessorDigest: eventDigest(activation) ?? ADMISSION_GENESIS_DIGEST,
        });
      }
    }
    const commands = await Promise.all(descriptors.map(indexedCommand));
    const unsigned = {
      kind: "takoserver.form-authority-plan@v1" as const,
      request: structuredClone(request),
      packages: entries.map((entry) => ({
        formRef: structuredClone(entry.formRef),
        schemaDigest: entry.formRef.schemaDigest as AdmissionDigest,
        packageDigest: entry.packageDigest,
        operations: [...entry.operations],
      })),
      currentHeads: structuredClone(state.heads),
      currentHeadDigest: state.headDigest,
      commands,
    };
    return { ...unsigned, planDigest: await canonicalFormAuthorityPlanDigest(unsigned) };
  };

  const plan = async (request: FormAuthorityPlanRequest): Promise<FormAuthorityPlan> => {
    validatePlanRequest(request);
    return await buildPlan(request, await readState(request));
  };

  const apply = async (candidate: FormAuthorityPlan): Promise<FormAuthorityApplyResult> => {
    assertPlanShape(candidate);
    assertRequestIdentity(candidate.request, options.identity);
    const { planDigest: _supplied, ...unsigned } = candidate;
    if ((await canonicalFormAuthorityPlanDigest(unsigned)) !== candidate.planDigest) {
      throw new FormAuthorityOperatorError("plan_digest_mismatch");
    }
    assertApplyReadiness(options.identity.environment, options.core, options.trust);
    const planned = await readState(candidate.request);
    if (
      planned.headDigest !== candidate.currentHeadDigest ||
      canonicalJson(planned.heads) !== canonicalJson(candidate.currentHeads)
    ) {
      throw new FormAuthorityOperatorError("head_drift");
    }
    const expected = await buildPlan(candidate.request, planned);
    if (canonicalJson(expected) !== canonicalJson(candidate)) {
      throw new FormAuthorityOperatorError(
        "plan_digest_mismatch",
        "Form authority plan differs from code-derived current operations",
      );
    }

    // All package closure and trust/Core adapter work happens before the first
    // D1/R2 mutation. The opaque handle itself is issued later because it must
    // bind the actual guarded publisher/checkpoint event digests.
    const prepared = new Map<string, { package: FormPackageInput; core: PreparedCoreAdmission }>();
    for (const command of candidate.commands) {
      if (command.kind === "AllowPublisher" || command.kind === "AppendCheckpoint") continue;
      const key = canonicalJson(command.formRef);
      if (prepared.has(key)) continue;
      const pkg = await options.packages.load({
        formRef: command.formRef,
        packageDigest: command.packageDigest,
      });
      if (pkg.packageDigest !== command.packageDigest || canonicalJson(pkg.formRef) !== key) {
        throw new FormAuthorityOperatorError("package_unavailable");
      }
      const verified = await options.trust.verify({
        environment: candidate.request.environment,
        hostId: candidate.request.hostId,
        package: pkg,
        evidence: candidate.request.evidence,
      });
      const packageCommand = candidate.commands.find(
        (value) =>
          (value.kind === "InstallPackage" || value.kind === "ReplacePackage") &&
          canonicalJson(value.formRef) === key,
      );
      prepared.set(key, {
        package: pkg,
        core: await options.core.prepare({
          environment: candidate.request.environment,
          hostId: candidate.request.hostId,
          operation: packageCommand?.kind === "InstallPackage" ? "install" : "replace",
          package: pkg,
          evidence: verified,
        }),
      });
    }

    // Trust/Core work may be slow. Re-read every durable head after it has
    // completed, then fence the live public Host immediately before each
    // command that can write R2 or D1. A stale public artifact therefore gets
    // no mutation window even if it changed after RPC admission.
    const before = await readState(candidate.request);
    if (
      before.headDigest !== candidate.currentHeadDigest ||
      canonicalJson(before.heads) !== canonicalJson(candidate.currentHeads)
    ) {
      throw new FormAuthorityOperatorError("head_drift");
    }
    const preparedExpected = await buildPlan(candidate.request, before);
    if (canonicalJson(preparedExpected) !== canonicalJson(candidate)) {
      throw new FormAuthorityOperatorError(
        "plan_digest_mismatch",
        "Form authority plan drifted during admission preparation",
      );
    }

    const admissionMode = options.core.readiness.released
      ? ("released-core" as const)
      : ("integration-fixture" as const);
    const productionEligible =
      options.core.readiness.productionEligible && options.trust.readiness.productionEligible;
    let publisherEventDigest = eventDigest(before.publisher);
    let checkpointEventDigest = eventDigest(before.checkpoint);
    const receipts: FormAuthorityActionReceipt[] = [];
    let failure: FormAuthorityApplyResult["failure"];
    for (const command of candidate.commands) {
      try {
        await options.assertMutationAuthority();
        const executable = executableCommand(
          command,
          candidate.request,
          options.identity.implementationDigest,
          prepared,
          publisherEventDigest,
          checkpointEventDigest,
        );
        const receipt = await options.admission.execute(executable.command);
        if (command.kind === "AllowPublisher") publisherEventDigest = receipt.eventDigest;
        if (command.kind === "AppendCheckpoint") checkpointEventDigest = receipt.eventDigest;
        receipts.push({
          index: command.index,
          commandDigest: command.commandDigest,
          kind: command.kind,
          eventDigest: receipt.eventDigest,
          state: receipt.state,
          changed: receipt.changed,
          admissionMode: executable.prepared?.admissionMode ?? admissionMode,
          productionEligible: executable.prepared?.productionEligible ?? productionEligible,
        });
      } catch (error) {
        failure = {
          index: command.index,
          commandDigest: command.commandDigest,
          code: errorCode(error),
        };
        break;
      }
    }
    const after = await readback(candidate.request);
    const nextPlan = await plan(candidate.request);
    const converged = failure === undefined && nextPlan.commands.length === 0;
    return {
      kind: "takoserver.form-authority-apply@v1",
      status: converged ? "converged" : "partial",
      planDigest: candidate.planDigest,
      receipts,
      admissionMode,
      productionEligible,
      readback: after,
      nextPlan,
      replanRequired: !converged,
      ...(failure ? { failure } : {}),
    };
  };

  return { plan, apply, readback };
}

export async function canonicalFormAuthorityPlanDigest(
  plan: Omit<FormAuthorityPlan, "planDigest">,
): Promise<AdmissionDigest> {
  return await canonicalDigest(plan);
}

async function indexedCommand(
  descriptor: FormAuthorityCommandDescriptor,
  index: number,
): Promise<FormAuthorityCommand> {
  return {
    ...descriptor,
    index,
    commandDigest: await canonicalDigest({ index, ...descriptor }),
  } as FormAuthorityCommand;
}

function executableCommand(
  command: FormAuthorityCommand,
  request: FormAuthorityPlanRequest,
  implementationDigest: AdmissionDigest,
  prepared: ReadonlyMap<string, { package: FormPackageInput; core: PreparedCoreAdmission }>,
  publisherEventDigest: AdmissionDigest | null,
  checkpointEventDigest: AdmissionDigest | null,
): { readonly command: AdmissionCommand; readonly prepared?: PreparedCoreAdmission } {
  const metadata = {
    actor: request.actor,
    reason: request.reason,
    predecessorDigest: command.predecessorDigest,
  };
  switch (command.kind) {
    case "AllowPublisher":
      return {
        command: { kind: command.kind, publisher: request.evidence.publisher, ...metadata },
      };
    case "AppendCheckpoint":
      if (!publisherEventDigest) {
        throw new FormAuthorityOperatorError("authority_state_conflict");
      }
      return {
        command: {
          kind: command.kind,
          publisherKey: request.evidence.publisher.publisherKey,
          checkpointApiVersion: request.evidence.checkpoint.apiVersion,
          policyDigest: request.evidence.publisher.policyDigest,
          policyEventDigest: publisherEventDigest,
          sequence: request.evidence.checkpoint.sequence,
          checkpointDigest: request.evidence.checkpoint.digest,
          entriesDigest: request.evidence.checkpoint.entriesDigest,
          previousCheckpointDigest: request.evidence.checkpoint.previousDigest,
          revokedPackageDigests: request.evidence.checkpoint.revokedPackageDigests ?? [],
          ...metadata,
        },
      };
    case "InstallPackage":
    case "ReplacePackage": {
      if (!publisherEventDigest || !checkpointEventDigest) {
        throw new FormAuthorityOperatorError("authority_state_conflict");
      }
      const value = prepared.get(canonicalJson(command.formRef));
      if (!value) throw new FormAuthorityOperatorError("package_unavailable");
      return {
        command: {
          kind: command.kind,
          package: value.package,
          handle: value.core.issue({
            policyEventDigest: publisherEventDigest,
            checkpointEventDigest,
          }),
          implementationDigest,
          ...metadata,
        },
        prepared: value.core,
      };
    }
    case "SetSupport":
      return {
        command: {
          kind: command.kind,
          formRef: command.formRef,
          packageDigest: command.packageDigest,
          supported: true,
          profile: {
            kind: "takoserver.form-support@v1",
            workerArtifactDigest: request.workerArtifactDigest,
            publicWorkerVersionId: request.publicWorkerVersionId,
            capabilityDigest: request.capabilityDigest,
            implementationDigest: request.implementationDigest,
          },
          operations: command.operations,
          implementationDigest,
          ...metadata,
        },
      };
    case "SetActivation":
      return {
        command: {
          kind: command.kind,
          formRef: command.formRef,
          packageDigest: command.packageDigest,
          active: true,
          audience: command.audience,
          implementationDigest,
          ...metadata,
        },
      };
  }
}

async function history(
  admission: FormAdmissionHost,
  chain: "publisher" | "checkpoint" | "install" | "support" | "activation",
): Promise<readonly AuthorityRow[]> {
  const view = await admission.inspect({ kind: "History", chain, limit: 1_000 });
  const events = view.events ?? [];
  if (events.length === 1_000) {
    throw new FormAuthorityOperatorError(
      "history_too_large",
      "bounded authority readback cannot prove the current head",
    );
  }
  return events;
}

function exactHead(rows: readonly AuthorityRow[], key: string): AuthorityRow | null {
  if (rows.length === 0) return null;
  const predecessors = new Set(
    rows
      .map((row) => row.predecessor_digest)
      .filter((value): value is string => typeof value === "string"),
  );
  const heads = rows.filter(
    (row) => typeof row.event_digest === "string" && !predecessors.has(row.event_digest),
  );
  if (heads.length !== 1) {
    throw new FormAuthorityOperatorError(
      "authority_state_conflict",
      `${key} authority chain has ${heads.length} heads`,
    );
  }
  return heads[0] ?? null;
}

function spaceAudience(activation: FormAuthorityPlanRequest["activation"]): {
  readonly kind: "space";
  readonly value: string;
} {
  const audience = takoformActivationAudience("space", activation);
  if (audience.kind !== "space") {
    throw new FormAuthorityOperatorError("invalid_request", "space activation is required");
  }
  return { kind: "space", value: audience.value };
}

function head(
  kind: FormAuthorityHead["kind"],
  key: string,
  row: AuthorityRow | null,
): FormAuthorityHead {
  return { kind, key, eventDigest: eventDigest(row) };
}

function eventDigest(row: AuthorityRow | null): AdmissionDigest | null {
  const value = row?.event_digest;
  if (value === undefined || value === null) return null;
  if (!isSha256Digest(value)) {
    throw new FormAuthorityOperatorError(
      "authority_state_conflict",
      "durable head digest is invalid",
    );
  }
  return value;
}

async function installMatches(
  row: AuthorityRow | null,
  entry: TakoformImplementationCatalogEntry,
  evidence: FormAuthorityTrustEvidence,
): Promise<boolean> {
  return (
    (row?.event_type === "install" || row?.event_type === "replace") &&
    row.package_digest === entry.packageDigest &&
    row.form_ref_json === canonicalJson(entry.formRef) &&
    (await installEvidenceMatches(row, entry, evidence))
  );
}

/**
 * AdmissionReport JSON is never executable authority. These comparisons only
 * prove that the opaque-handle-derived install head retained the exact trust
 * pins bound by this plan; a mismatch requires a fresh Core evaluation.
 */
async function installEvidenceMatches(
  row: AuthorityRow,
  entry: TakoformImplementationCatalogEntry,
  evidence: FormAuthorityTrustEvidence,
): Promise<boolean> {
  if (
    row.publisher_key !== evidence.publisher.publisherKey ||
    row.policy_digest !== evidence.publisher.policyDigest ||
    row.checkpoint_api_version !== evidence.checkpoint.apiVersion ||
    row.checkpoint_sequence !== evidence.checkpoint.sequence ||
    row.checkpoint_digest !== evidence.checkpoint.digest ||
    row.source_commit !== evidence.publisher.sourceCommit ||
    row.workflow_commit !== evidence.publisher.workflowCommit ||
    row.build_config_commit !== evidence.publisher.buildConfigCommit ||
    row.repository_identifier !== evidence.publisher.repositoryIdentifier ||
    row.owner_identifier !== evidence.publisher.ownerIdentifier ||
    row.namespace_group !== evidence.publisher.group ||
    row.namespace_grant_digest !== evidence.publisher.namespaceGrantDigest ||
    typeof row.admission_report_json !== "string"
  ) {
    return false;
  }
  let report: unknown;
  try {
    report = JSON.parse(row.admission_report_json);
  } catch {
    throw new FormAuthorityOperatorError(
      "authority_state_conflict",
      "installed admission report is invalid",
    );
  }
  if (!isRecord(report)) return false;
  if (
    !isSha256Digest(row.admission_report_digest) ||
    (await canonicalDigest(report)) !== row.admission_report_digest
  ) {
    throw new FormAuthorityOperatorError(
      "authority_state_conflict",
      "installed admission report digest does not match its durable body",
    );
  }
  const packageReport = report.package;
  const signature = report.signature;
  const revocation = report.revocation;
  return (
    report.status === "admitted" &&
    (report.operation === "install" || report.operation === "replace") &&
    isRecord(packageReport) &&
    packageReport.packageDigest === entry.packageDigest &&
    canonicalJson(packageReport.formRef) === canonicalJson(entry.formRef) &&
    isRecord(signature) &&
    signature.subjectDigest === entry.packageDigest &&
    signature.bundleDigest === evidence.bundleDigest &&
    signature.trustedRootDigest === evidence.publisher.trustedRootDigest &&
    isRecord(revocation) &&
    revocation.checkpointApiVersion === evidence.checkpoint.apiVersion &&
    revocation.sequence === evidence.checkpoint.sequence &&
    revocation.checkpointDigest === evidence.checkpoint.digest &&
    revocation.entriesDigest === evidence.checkpoint.entriesDigest &&
    revocation.revoked !== true
  );
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function supportMatches(
  row: AuthorityRow | null,
  entry: TakoformImplementationCatalogEntry,
  implementationDigest: AdmissionDigest,
): boolean {
  if (
    row?.supported !== 1 ||
    row.package_digest !== entry.packageDigest ||
    row.implementation_digest !== implementationDigest ||
    typeof row.operations_json !== "string"
  ) {
    return false;
  }
  try {
    return canonicalJson(JSON.parse(row.operations_json)) === canonicalJson(entry.operations);
  } catch {
    throw new FormAuthorityOperatorError(
      "authority_state_conflict",
      "support operations are invalid",
    );
  }
}

function activationMatches(
  row: AuthorityRow | null,
  implementationDigest: AdmissionDigest,
): boolean {
  return row?.active === 1 && row.implementation_digest === implementationDigest;
}

function assertExistingAuthorityMatches(
  request: FormAuthorityPlanRequest,
  state: AuthorityState,
): void {
  if (state.publisher && !publisherMatches(state.publisher, request.evidence)) {
    throw new FormAuthorityOperatorError(
      "authority_state_conflict",
      "publisher head differs from the signed plan evidence",
    );
  }
  if (state.checkpoint && !checkpointMatches(state.checkpoint, request.evidence, state.publisher)) {
    throw new FormAuthorityOperatorError(
      "authority_state_conflict",
      "checkpoint head differs from the signed plan evidence",
    );
  }
}

function publisherMatches(row: AuthorityRow, evidence: FormAuthorityTrustEvidence): boolean {
  const publisher = evidence.publisher;
  return (
    (row.event_type === "allow" || row.event_type === "rotate") &&
    row.publisher_key === publisher.publisherKey &&
    row.policy_digest === publisher.policyDigest &&
    row.policy_json === canonicalJson(publisher.policy ?? {}) &&
    row.oidc_issuer === publisher.oidcIssuer &&
    row.source_repository === publisher.sourceRepository &&
    row.workflow === publisher.workflow &&
    row.ref === publisher.ref &&
    row.publisher_identity === publisher.identity &&
    row.trusted_root_digest === publisher.trustedRootDigest &&
    row.source_commit === publisher.sourceCommit &&
    row.workflow_commit === publisher.workflowCommit &&
    row.build_config_commit === publisher.buildConfigCommit &&
    row.repository_identifier === publisher.repositoryIdentifier &&
    row.owner_identifier === publisher.ownerIdentifier &&
    row.namespace_group === publisher.group &&
    row.namespace_grant_digest === publisher.namespaceGrantDigest
  );
}

function checkpointMatches(
  row: AuthorityRow,
  evidence: FormAuthorityTrustEvidence,
  publisher: AuthorityRow | null,
): boolean {
  return (
    row.publisher_key === evidence.publisher.publisherKey &&
    row.checkpoint_api_version === evidence.checkpoint.apiVersion &&
    row.sequence === evidence.checkpoint.sequence &&
    row.checkpoint_digest === evidence.checkpoint.digest &&
    row.entries_digest === evidence.checkpoint.entriesDigest &&
    row.previous_checkpoint_digest === evidence.checkpoint.previousDigest &&
    row.policy_digest === evidence.publisher.policyDigest &&
    row.policy_event_digest === publisher?.event_digest &&
    row.revoked_package_digests_json ===
      canonicalJson(evidence.checkpoint.revokedPackageDigests ?? [])
  );
}

function validateIdentity(identity: FormAuthorityIdentity): void {
  if (
    !["integration", "rehearsal", "production"].includes(identity.environment) ||
    !boundedIdentity(identity.hostId) ||
    !isSha256Digest(identity.workerArtifactDigest) ||
    !workerVersionId(identity.publicWorkerVersionId) ||
    !isSha256Digest(identity.capabilityDigest) ||
    !isSha256Digest(identity.implementationDigest)
  ) {
    throw new FormAuthorityOperatorError("invalid_request", "Form authority identity is invalid");
  }
}

function validatePlanRequest(request: FormAuthorityPlanRequest): void {
  if (
    request.kind !== "takoserver.form-authority-plan-request@v1" ||
    request.activation?.kind !== "space" ||
    !boundedIdentity(request.activation.tenantId) ||
    !boundedIdentity(request.activation.space) ||
    !boundedText(request.actor, 4_096) ||
    !boundedText(request.reason, 4_096) ||
    !request.evidence ||
    !request.evidence.publisher ||
    !boundedIdentity(request.evidence.publisher.publisherKey)
  ) {
    throw new FormAuthorityOperatorError("invalid_request");
  }
  validateIdentity(request);
}

function assertRequestIdentity(
  request: FormAuthorityPlanRequest,
  identity: FormAuthorityIdentity,
): void {
  validatePlanRequest(request);
  for (const key of [
    "environment",
    "hostId",
    "workerArtifactDigest",
    "publicWorkerVersionId",
    "capabilityDigest",
    "implementationDigest",
  ] as const) {
    if (request[key] !== identity[key]) {
      throw new FormAuthorityOperatorError(
        "identity_mismatch",
        `Form authority ${key} does not match this Worker`,
      );
    }
  }
}

function assertPlanShape(plan: FormAuthorityPlan): void {
  if (
    plan?.kind !== "takoserver.form-authority-plan@v1" ||
    !isSha256Digest(plan.planDigest) ||
    !isSha256Digest(plan.currentHeadDigest) ||
    !Array.isArray(plan.commands) ||
    plan.commands.some((command, index) => command.index !== index)
  ) {
    throw new FormAuthorityOperatorError("plan_digest_mismatch");
  }
}

function assertApplyReadiness(
  environment: FormAuthorityEnvironment,
  core: CoreAdmissionAdapter,
  trust: SignedTrustEvidenceAdapter,
): void {
  if (
    !core.readiness.available ||
    !trust.readiness.available ||
    (environment === "production" &&
      (!core.readiness.released ||
        !trust.readiness.released ||
        !core.readiness.productionEligible ||
        !trust.readiness.productionEligible))
  ) {
    throw new FormAuthorityOperatorError(
      "production_not_ready",
      "Form authority apply needs released Core admission and signed trust adapters",
    );
  }
}

function boundedIdentity(value: unknown): value is string {
  return boundedText(value, 255) && /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u.test(value);
}

function boundedText(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

function errorCode(error: unknown): string {
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string" &&
    /^[a-z][a-z0-9_]{0,63}$/u.test(error.code)
  ) {
    return error.code;
  }
  return "action_failed";
}

export function formAuthorityPackageProfile(identity: FormAuthorityIdentity): JsonObject {
  return {
    kind: "takoserver.form-support@v1",
    workerArtifactDigest: identity.workerArtifactDigest,
    publicWorkerVersionId: identity.publicWorkerVersionId,
    capabilityDigest: identity.capabilityDigest,
    implementationDigest: identity.implementationDigest,
  };
}

function workerVersionId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(value)
  );
}
