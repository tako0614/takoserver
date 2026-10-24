import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { API_KEY_SCOPES, type ApiKeyScope } from "../src/auth.ts";
import { runConsole } from "./deploy/console.ts";
import { DEPLOY_CONTRACT } from "./deploy/contract.ts";
import {
  type D1SnapshotRestoreDeclaration,
  runD1SnapshotRestore,
} from "./deploy/d1-snapshot-restore.ts";
import { DeployError, deployFailureAftermath, PHASE_EXIT_CODE } from "./deploy/errors.ts";
import { runExistingSpaceOperator } from "./deploy/existing-space-operator.ts";
import { runFormAuthority } from "./deploy/form-authority.ts";
import { runFormAuthorityIdentityProbe } from "./deploy/form-authority-identity-probe.ts";
import { runFormAuthorityInvoke } from "./deploy/form-authority-invoke.ts";
import { loadFormAuthorityScopeTransition } from "./deploy/form-authority-scope-transition.ts";
import { runOperatorIdentity } from "./deploy/identity.ts";
import { runIntegrationE2eCredentials } from "./deploy/integration-e2e-credentials.ts";
import { runIntegrationHostRetirement } from "./deploy/integration-host-retirement.ts";
import {
  type IntegrationMoneyShadowCreateDeclaration,
  runIntegrationMoneyShadowCreate,
} from "./deploy/integration-money-shadow-create.ts";
import {
  type MoneyShadowNativeProbeDeclaration,
  runIntegrationMoneyShadowNativeProbe,
} from "./deploy/integration-money-shadow-native-probe.ts";
import { runIntegrationOrganizationBootstrap } from "./deploy/integration-organization-bootstrap.ts";
import { runIntegrationStorageDisposal } from "./deploy/integration-storage-disposal.ts";
import {
  type IntegrationStorageGenerationInvocation,
  loadIntegrationStorageOriginalCreateInput,
  runIntegrationStorageGeneration,
} from "./deploy/integration-storage-generation.ts";
import { runIntegrationWorkerBootstrap } from "./deploy/integration-worker-bootstrap.ts";
import { runOrgApiKey } from "./deploy/org-api-key.ts";
import { requireEnvironment } from "./deploy/process.ts";
import {
  type ProductionD1FreshInitInvocation,
  runProductionD1FreshInit,
} from "./deploy/production-d1-fresh-init.ts";
import type { DeployEnvironment } from "./deploy/qualification.ts";
import {
  type RehearsalD1CreateDeclaration,
  runRehearsalD1Create,
} from "./deploy/rehearsal-d1-create.ts";
import { runRetirement } from "./deploy/retirement.ts";
import {
  runD1Schema,
  runD1SchemaRehearsalBaseline,
  SCHEMA_WAVE_BOUNDARIES,
  type SchemaWaveBoundary,
} from "./deploy/schema.ts";
import { runD1Schema0058Rehearsal } from "./deploy/schema-0058-rehearsal.ts";
import {
  type IntegrationMoneyShadowRehearsalDeclaration,
  type MoneyRehearsalDeclaration,
  runIntegrationMoneyShadowRehearsal,
  runMoneyUnitRehearsal,
} from "./deploy/schema-money-unit-rehearsal.ts";
import { runSigning } from "./deploy/signing.ts";
import { runSponsorshipAuthority } from "./deploy/sponsorship-authority.ts";
import { runStaticSite } from "./deploy/static.ts";
import { loadTarget, targetPath } from "./deploy/target.ts";
import { isWorkerVersionId, runWorker } from "./deploy/worker.ts";
import { runWorkerClosureTransition } from "./deploy/worker-closure-transition.ts";
import type { WorkerClosureDelta } from "./deploy/worker-state.ts";
import type { WorkerSurfaceTransition } from "./deploy/worker-surface-transition.ts";

const USAGE = `takoserver deploy

  bun run deploy -- --contract
  bun run deploy -- <surface> --status --environment=<integration|rehearsal|production> --commit=<sha>
  bun run deploy -- <surface> --apply  --environment=<integration|rehearsal|production> --commit=<sha>
  bun run deploy -- takoserver-operator-identity --<status|apply> --environment=<integration|rehearsal|production> --commit=<sha>
    --organization=org_...
  bun run deploy -- takoserver-integration-operator-identity --<status|apply> --environment=integration --commit=<sha>
    --organization=org_... (legacy spelling; integration only)
  bun run deploy -- takoserver-integration-e2e-credentials --<issue|status|revoke> --environment=integration --commit=<sha>
  bun run deploy -- takoserver-integration-organization-bootstrap --<status|apply> --environment=integration --commit=<sha>
  bun run deploy -- takoserver-integration-storage-generation --<status|apply> --environment=integration --commit=<sha>
    --generation=<32-lowercase-hex> (new isolated D1/R2 only; never resets an existing target)
    [--fresh-lineage=<v2-artifacts-0075|v2-0088|v2-0089|v2-0091|v2-0092|v2-0100|v2-0100-money-preserved>] (fixed fresh payload; default remains 0066;
    v2-0091/v2-0092/v2-0100/v2-0100-money-preserved are staging-only and their apply requires TAKOSERVER_DEPLOY_TARGET_PRODUCTION to refuse the production D1;
    v2-0100 is the plain serving lineage whose import also claims the test Stripe realm;
    v2-0100-money-preserved imports the Money-preserved 0100 shape, the test realm claim and one fresh Writer epoch row)
    [--epoch-record-directory=<absolute-dir>] (v2-0100-money-preserved only: operator-owned 0700 directory where apply
    writes the 0600 Writer epoch record and status verifies it; omitted, apply keeps it in a retained temporary root)
  bun run deploy -- takoserver-integration-storage-disposal --<status|apply> --environment=integration --commit=<sha>
    (one exact selected D1/R2 pair only; refuses current regular/dispatch Worker bindings)
  bun run deploy -- takoserver-integration-host-retirement --<status|apply> --environment=integration --commit=<sha>
    --retired-target=/absolute/old-target.json --retired-deployment=<uuid> --retired-version=<uuid>
    (one replaced public Host only; never deletes storage or forces associated binding removal)
  bun run deploy -- takoserver-integration-worker-bootstrap --<status|apply> --environment=integration --commit=<sha>
    (first public Host publication only; existing normal Hosts use their normal lifecycle)
  bun run deploy -- takoserver-integration-worker-bootstrap --apply --environment=integration --commit=<sha>
    --repair-original-money-maintenance (same original-maintenance Worker successor only;
    requires the original-create, maintenance-selection and repair-selection locators; never replays bootstrap)
  bun run deploy -- takoserver-sponsorship-authority-worker --<status|apply> --environment=<env> --commit=<sha>
  bun run deploy -- takoserver-sponsorship-public-route-retirement --<status|apply> --environment=<integration|production> --commit=<sha>
    --legacy-host-runtime-predecessor-version=<uuid> [--reverse]
  bun run deploy -- takoserver-org-api-key --<mint|status|revoke> --environment=<env> --commit=<sha>
    --organization=org_... [--key-name=<name> --scope=<scope> --expires-in-days=<n>] [--key-id=key_...]
  Integration --through-migration=0103 selects only the fixed audited100 -> original101/102/103
  source registration plus its same-artifact mandatory deployment/RP receipts in one import.
  It requires source-proved pre-auth103-quiesced all-traffic Worker and private install custody.
  Integration --through-migration=0104 separately appends only the exact Root-registered
  Financial0104 recipe after installed Auth103 (thawed when Money-preserved) in one guarded import.
  Integration --through-migration=0105 then appends only Root's exact 0105 Org capture recipe
  after that exact installed 0104 in one guarded import.
  Integration --through-migration=0106 then appends only the pinned Forward native custody
  recipe after exact installed 0105 in one guarded import.
  Integration --through-migration=0107 then appends only the pinned shared staging physical
  source after exact installed 0106 in one guarded import.
  Integration original-custody held post94 status also accepts --through-migration=0098.
  It requires the original convert declaration, TAKOSERVER_D1_MONEY_POST94_DECLARATION_PATH,
  and TAKOSERVER_D1_MONEY_NORMAL_WORKER_SELECTOR_PATH; apply remains unavailable.
  Integration --through-migration=0100 continues only original terminal98 custody through
  audited 0099/0100 in the same original Money D1 path. Status is GET-only after dispatch.

  D1 schema status/apply may select one fixed next-wave boundary:
    --through-migration=<0022|0028|0033|0036|0043|0044|0045|0046|0047|0048|0049|0050|0051|0052|0053|0054|0055|0056|0057|0058|0088|0092|0093|0094>
  Integration without a selector keeps its disposable suffix path; selected integration applies
  only the audited wave and emits integration-protected-wave evidence, never a rehearsal receipt.
  Rehearsal and production still require the selector and their receipt chain.
  Pending 0043 additionally requires the staged pre-0043-quiesced Worker target and the absolute
  operator-private TAKOSERVER_ARTIFACT_BLOB_IO_QUIESCENCE_RECEIPT_PATH documented in docs/deploy.md.
  takoserver-d1-schema-rehearsal-baseline is fixed empty -> 0022, rehearsal-only, and accepts no selector.
  takoserver-d1-schema-0058-rehearsal is an isolated synthetic 0057 -> 0058 D1 qualification,
    rehearsal-only, no selector or production receipt; see docs/deploy.md.
    --protected-reference=<integration|production> explicitly reads that environment's
    operator-private deploy target with a separate TAKOSERVER_D1_0058_REFERENCE_API_TOKEN;
    only the selected isolated rehearsal D1 is mutated, and the receipt grants no apply authority.
  The protected 0058 selector is status-only until owner-backed public Host and private CPE
    writer-drain plus target-bound volume/import qualification are implemented; apply refuses.
  takoserver-rehearsal-d1-create creates one empty rehearsal D1 from a separate owned declaration;
    no target descriptor, schema import, binding change, or production mode is accepted.
  takoserver-d1-money-cutover-rehearsal exercises synthetic 0092/0093/0094 imports on that
    explicit rehearsal D1 only; each reviewed phase uses protected no-overwrite custody.
  takoserver-integration-money-shadow-create creates one fresh synthetic-only integration D1
    from a reviewed staging-0092 origin and canonical Wrangler OAuth, with no target adoption.
  takoserver-integration-money-shadow-rehearsal runs the same reviewed synthetic import phases
    on that exact terminal shadow D1, never on the staging D1 or ordinary rehearsal target.
  takoserver-integration-money-shadow-native-probe publishes one fresh shadow-only diagnostic
    Worker, then runs one fixed authenticated native D1.batch POST after separate reviews.
  takoserver-d1-snapshot-restore restores one pinned export dump into one declared empty
    rehearsal D1; the dump is NUL-normalized and the result is verified by readback, so a partial
    application is never reported as success.
  takoserver-production-d1-fresh-init creates one new empty production D1 and applies the complete
    audited default 0001-0069 lineage, or explicit --fresh-lineage=v2-0088 or
    --fresh-lineage=v2-0089, in one reviewed command. It is production-only, requires the
    explicit --generation=<32-lowercase-hex> and TAKOSERVER_DEPLOY_TARGET_PRODUCTION, and never
    reads, adopts, resets, archives or deletes the incumbent production database or its bucket.
  The authority cutover may add --legacy-predecessor-version=<uuid> for integration bootstrap.
  Hosted-edge authority transition requires the named
  --legacy-host-runtime-predecessor-version=<uuid> selector in integration or production.
  Every Worker-publishing surface accepts the same reviewed forward transition:
  --closure-predecessor-version=<uuid> with an explicit delta of repeatable
  --retire-var=NAME, --add-var=NAME, --refresh-var=NAME, --refresh-service-binding=NAME,
  --add-binding=NAME, --add-secret=NAME and --rotate-secret=NAME. Service-binding refresh is
  integration-only; its predecessor service/entrypoint must differ from the target-derived tuple.
  On the Host and two Form-authority Workers in integration only, the
  optional storage rebind is exactly the pair --rebind-state-database-from=<uuid> and
  --rebind-object-bucket-from=<name>; both are required and successor identities come only from
  the selected target after exact generated-storage/schema readback. --refresh-var publishes a changed value of a var both sides already
  declare, --add-binding publishes a binding the current code derives and the predecessor lacks,
  and added and rotated secret values come only from TAKOSERVER_WORKER_CLOSURE_SECRET_DIRECTORY.
  The Form-authority Worker surfaces and the identity probe accept
  --adopt-live=/absolute/candidate.json with --status: it writes a candidate target descriptor
  adopting the live value of every descriptor-owned binding that drifted, and never edits the
  descriptor in place.
  Hosted-edge authority/topology retirement uses --legacy-host-runtime-predecessor-version=<uuid>
  and --reverse; token retirement is forward-only.
  Post-token attribution repair uses both --legacy-host-runtime-predecessor-version=<uuid>
  and --unattributed-successor-version=<uuid>; it has no --reverse mode.
  Integration Form-authority scope retirement uses the operator-private
  --form-authority-scope-transition=/absolute/file.json selector only on deactivation,
  the route-less authority Worker and its operator gateway.
  takoserver-form-authority-worker --apply accepts --bootstrap-verifier-bridge only where that
  Worker has no Version at all, together with
  --bootstrap-probe-predecessor-version=<uuid>. The pinned identity-probe Version must already be
  the exact predecessor missing only FORM_AUTHORITY; it is checked again at the mutation fence.
The current target descriptor is selected only by the exact environment.
Host retirement additionally requires an explicit historical descriptor.
There is no deploy-plan flag, ledger, current-target override or mixed mutation controller.
`;

type Surface = (typeof DEPLOY_CONTRACT.surfaces)[number]["surface"];
type CredentialSurface = "takoserver-integration-e2e-credentials";
type OrgApiKeySurface = "takoserver-org-api-key";
type StorageGenerationSurface = "takoserver-integration-storage-generation";
type StorageDisposalSurface = "takoserver-integration-storage-disposal";
type HostRetirementSurface = "takoserver-integration-host-retirement";
type RehearsalD1CreateSurface = "takoserver-rehearsal-d1-create";
type MoneyRehearsalSurface = "takoserver-d1-money-cutover-rehearsal";
type MoneyShadowCreateSurface = "takoserver-integration-money-shadow-create";
type MoneyShadowRehearsalSurface = "takoserver-integration-money-shadow-rehearsal";
type MoneyShadowNativeProbeSurface = "takoserver-integration-money-shadow-native-probe";
type ProductionD1FreshInitSurface = "takoserver-production-d1-fresh-init";
type D1SnapshotRestoreSurface = "takoserver-d1-snapshot-restore";
type StandardSurface = Exclude<
  Surface,
  | CredentialSurface
  | OrgApiKeySurface
  | StorageGenerationSurface
  | StorageDisposalSurface
  | HostRetirementSurface
  | RehearsalD1CreateSurface
  | MoneyRehearsalSurface
  | MoneyShadowCreateSurface
  | MoneyShadowRehearsalSurface
  | MoneyShadowNativeProbeSurface
  | ProductionD1FreshInitSurface
  | D1SnapshotRestoreSurface
>;

interface InvocationBase {
  readonly environment: DeployEnvironment;
  readonly commit: string;
  readonly organizationId?: string;
  readonly legacyPredecessorVersionId?: string;
  readonly legacyHostRuntimePredecessorVersionId?: string;
  readonly closurePredecessorVersionId?: string;
  readonly closureDelta?: WorkerClosureDelta;
  readonly unattributedSuccessorVersionId?: string;
  readonly formAuthorityScopeTransitionPath?: string;
  readonly adoptLivePath?: string;
  readonly bootstrapVerifierBridge?: boolean;
  readonly bootstrapProbePredecessorVersionId?: string;
  readonly throughMigration?: SchemaWaveBoundary;
  readonly protectedReferenceEnvironment?: "integration" | "production";
  readonly reverse?: boolean;
  readonly repairOriginalMoneyMaintenance?: boolean;
}

type Invocation =
  | (Omit<InvocationBase, "throughMigration"> & {
      readonly surface: "takoserver-d1-schema";
      readonly action: "status" | "apply";
      readonly environment: "integration";
      readonly throughMigration: "0098" | "0100" | "0103" | "0104" | "0105" | "0106" | "0107";
    })
  | (InvocationBase & {
      readonly surface:
        | MoneyShadowCreateSurface
        | MoneyShadowRehearsalSurface
        | MoneyShadowNativeProbeSurface;
      readonly action: "status" | "apply";
      readonly environment: "integration";
    })
  | (InvocationBase & {
      readonly surface: MoneyRehearsalSurface;
      readonly action: "status" | "apply";
      readonly environment: "rehearsal";
    })
  | (InvocationBase & {
      readonly surface: RehearsalD1CreateSurface;
      readonly action: "status" | "apply";
      readonly environment: "rehearsal";
    })
  | (InvocationBase & {
      readonly surface: D1SnapshotRestoreSurface;
      readonly action: "status" | "apply";
      readonly environment: "rehearsal";
    })
  | (InvocationBase & {
      readonly surface: StorageGenerationSurface;
      readonly action: "status" | "apply";
      readonly generation: string;
      readonly freshLineage?:
        | "v2-artifacts-0075"
        | "v2-0088"
        | "v2-0089"
        | "v2-0091"
        | "v2-0092"
        | "v2-0100"
        | "v2-0100-money-preserved";
      readonly epochRecordDirectory?: string;
    })
  | (InvocationBase & {
      readonly surface: ProductionD1FreshInitSurface;
      readonly action: "status" | "apply";
      readonly generation: string;
      readonly freshLineage?: "v2-0088" | "v2-0089";
    })
  | (InvocationBase & {
      readonly surface: StorageDisposalSurface;
      readonly action: "status" | "apply";
    })
  | (InvocationBase & {
      readonly surface: HostRetirementSurface;
      readonly action: "status" | "apply";
      readonly retiredTargetPath: string;
      readonly retiredDeploymentId: string;
      readonly retiredVersionId: string;
    })
  | (InvocationBase & {
      readonly surface: StandardSurface;
      readonly action: "status" | "apply";
    })
  | (InvocationBase & {
      readonly surface: CredentialSurface;
      readonly action: "issue" | "status" | "revoke";
    })
  | (InvocationBase & {
      readonly surface: OrgApiKeySurface;
      readonly action: "mint" | "status" | "revoke";
      readonly organizationId: string;
      readonly keyName?: string;
      readonly scopes?: readonly ApiKeyScope[];
      readonly expiresInDays?: number;
      readonly apiKeyId?: string;
    });

interface ParsedInvocation {
  readonly surface: Surface;
  readonly action: "status" | "apply" | "issue" | "revoke" | "mint";
  readonly environment: DeployEnvironment;
  readonly commit: string;
  readonly legacyPredecessorVersionId?: string;
  readonly legacyHostRuntimePredecessorVersionId?: string;
  readonly closurePredecessorVersionId?: string;
  readonly closureDelta?: WorkerClosureDelta;
  readonly unattributedSuccessorVersionId?: string;
  readonly formAuthorityScopeTransitionPath?: string;
  readonly adoptLivePath?: string;
  readonly bootstrapVerifierBridge?: boolean;
  readonly bootstrapProbePredecessorVersionId?: string;
  readonly throughMigration?:
    | SchemaWaveBoundary
    | "0098"
    | "0100"
    | "0103"
    | "0104"
    | "0105"
    | "0106"
    | "0107";
  readonly freshLineage?:
    | "v2-artifacts-0075"
    | "v2-0088"
    | "v2-0089"
    | "v2-0091"
    | "v2-0092"
    | "v2-0100"
    | "v2-0100-money-preserved";
  readonly epochRecordDirectory?: string;
  readonly protectedReferenceEnvironment?: "integration" | "production";
  readonly organizationId?: string;
  readonly keyName?: string;
  readonly scopes?: readonly ApiKeyScope[];
  readonly expiresInDays?: number;
  readonly apiKeyId?: string;
  readonly reverse?: boolean;
  readonly repairOriginalMoneyMaintenance?: boolean;
}

/** The durable organization API key surface is the only one with key operands. */
const MAX_ORG_API_KEY_FLAGS = 12;

/**
 * Every surface that publishes a Cloudflare Worker fences its live Version
 * against the exact closure the current code and target derive, so every one of
 * them can be stranded by a code advance that changes that closure. They share
 * the one declaration that brings a pinned predecessor forward.
 */
const TRANSITION_SURFACES: readonly Surface[] = [
  "takoserver-worker-authority-cutover",
  "takoserver-sponsorship-authority-worker",
  "takoserver-form-authority-worker",
  "takoserver-integration-form-authority-worker",
  "takoserver-integration-form-authority-operator-worker",
  "takoserver-form-authority-identity-probe",
];

/**
 * Surfaces whose fenced closure carries descriptor-owned identity — the Form
 * authority Host, operator tenant/Space, gateway origin and Worker names — and
 * can therefore answer which side of a drift is the truth.
 */
const ADOPT_LIVE_SURFACES: readonly Surface[] = [
  "takoserver-form-authority-worker",
  "takoserver-integration-form-authority-worker",
  "takoserver-integration-form-authority-operator-worker",
  "takoserver-form-authority-identity-probe",
];

/**
 * The closure transition is the only selector with repeatable operands. Its
 * declaration stays bounded so an invocation can never grow into an unreviewed
 * bulk rewrite of the realized closure.
 */
const MAX_CLOSURE_DELTA_FLAGS = 32;
const CLOSURE_DELTA_NAME = /^[A-Z][A-Z0-9_]{0,63}$/u;
const STORAGE_REBIND_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const STORAGE_REBIND_BUCKET = /^[a-z0-9][a-z0-9-]{2,62}$/u;
const MAX_STORAGE_REBIND_FLAGS = 2;
const STORAGE_REBIND_SURFACES: readonly Surface[] = [
  "takoserver-worker-authority-cutover",
  "takoserver-form-authority-worker",
  "takoserver-integration-form-authority-worker",
];

function parseInvocation(args: readonly string[]): Invocation | null {
  if (
    args.length < 4 ||
    args.length >
      7 + Math.max(MAX_CLOSURE_DELTA_FLAGS + MAX_STORAGE_REBIND_FLAGS, MAX_ORG_API_KEY_FLAGS)
  )
    return null;
  const [surfaceValue, ...flags] = args;
  if (!isSurface(surfaceValue)) return null;
  let action: ParsedInvocation["action"] | null = null;
  let environment: DeployEnvironment | null = null;
  let commit: string | null = null;
  let generation: string | null = null;
  let freshLineage:
    | "v2-artifacts-0075"
    | "v2-0088"
    | "v2-0089"
    | "v2-0091"
    | "v2-0092"
    | "v2-0100"
    | "v2-0100-money-preserved"
    | null = null;
  let retiredTargetPath: string | null = null;
  let epochRecordDirectory: string | null = null;
  let retiredDeploymentId: string | null = null;
  let retiredVersionId: string | null = null;
  let legacyPredecessorVersionId: string | null = null;
  let legacyHostRuntimePredecessorVersionId: string | null = null;
  let closurePredecessorVersionId: string | null = null;
  let predecessorStateDatabaseId: string | null = null;
  let predecessorObjectBucketName: string | null = null;
  const retireVars: string[] = [];
  const addVars: string[] = [];
  const refreshVars: string[] = [];
  const refreshServiceBindings: string[] = [];
  const addBindings: string[] = [];
  const addSecrets: string[] = [];
  const rotateSecrets: string[] = [];
  let unattributedSuccessorVersionId: string | null = null;
  let formAuthorityScopeTransitionPath: string | null = null;
  let adoptLivePath: string | null = null;
  let bootstrapVerifierBridge = false;
  let bootstrapProbePredecessorVersionId: string | null = null;
  let throughMigration:
    | SchemaWaveBoundary
    | "0098"
    | "0100"
    | "0103"
    | "0104"
    | "0105"
    | "0106"
    | "0107"
    | null = null;
  let protectedReferenceEnvironment: "integration" | "production" | null = null;
  let organizationId: string | null = null;
  let keyName: string | null = null;
  const scopes: ApiKeyScope[] = [];
  let expiresInDays: number | null = null;
  let apiKeyId: string | null = null;
  let reverse = false;
  let repairOriginalMoneyMaintenance = false;
  for (const flag of flags) {
    if (flag === "--repair-original-money-maintenance") {
      if (repairOriginalMoneyMaintenance) return null;
      repairOriginalMoneyMaintenance = true;
      continue;
    }
    if (flag.startsWith("--epoch-record-directory=")) {
      const value = flag.slice("--epoch-record-directory=".length);
      if (epochRecordDirectory !== null || !isAbsolute(value) || /[\0\r\n]/u.test(value))
        return null;
      epochRecordDirectory = value;
      continue;
    }
    if (flag.startsWith("--retired-target=")) {
      const value = flag.slice("--retired-target=".length);
      if (retiredTargetPath !== null || !isAbsolute(value) || /[\0\r\n]/u.test(value)) return null;
      retiredTargetPath = value;
      continue;
    }
    if (flag.startsWith("--retired-deployment=")) {
      const value = flag.slice("--retired-deployment=".length);
      if (retiredDeploymentId !== null || !isWorkerVersionId(value)) return null;
      retiredDeploymentId = value;
      continue;
    }
    if (flag.startsWith("--retired-version=")) {
      const value = flag.slice("--retired-version=".length);
      if (retiredVersionId !== null || !isWorkerVersionId(value)) return null;
      retiredVersionId = value;
      continue;
    }
    if (
      flag === "--status" ||
      flag === "--apply" ||
      flag === "--issue" ||
      flag === "--revoke" ||
      flag === "--mint"
    ) {
      if (action !== null) return null;
      action = flag.slice(2) as ParsedInvocation["action"];
      continue;
    }
    if (flag.startsWith("--organization=")) {
      if (organizationId !== null) return null;
      const value = flag.slice("--organization=".length);
      if (!/^org_[A-Za-z0-9][A-Za-z0-9._:-]{0,123}$/u.test(value)) return null;
      organizationId = value;
      continue;
    }
    if (flag.startsWith("--key-name=")) {
      if (keyName !== null) return null;
      const value = flag.slice("--key-name=".length);
      if (!/^[a-z0-9][a-z0-9-]{0,63}$/u.test(value)) return null;
      keyName = value;
      continue;
    }
    if (flag.startsWith("--scope=")) {
      const value = flag.slice("--scope=".length);
      if (!API_KEY_SCOPES.includes(value as ApiKeyScope) || scopes.includes(value as ApiKeyScope)) {
        return null;
      }
      scopes.push(value as ApiKeyScope);
      continue;
    }
    if (flag.startsWith("--expires-in-days=")) {
      if (expiresInDays !== null) return null;
      const value = flag.slice("--expires-in-days=".length);
      if (!/^[1-9][0-9]{0,3}$/u.test(value)) return null;
      expiresInDays = Number(value);
      continue;
    }
    if (flag.startsWith("--key-id=")) {
      if (apiKeyId !== null) return null;
      const value = flag.slice("--key-id=".length);
      if (!/^key_[A-Za-z0-9][A-Za-z0-9._:-]{0,123}$/u.test(value)) return null;
      apiKeyId = value;
      continue;
    }
    if (flag.startsWith("--environment=")) {
      if (environment !== null) return null;
      const value = flag.slice("--environment=".length);
      if (value !== "integration" && value !== "rehearsal" && value !== "production") {
        return null;
      }
      environment = value;
      continue;
    }
    if (flag.startsWith("--protected-reference=")) {
      if (protectedReferenceEnvironment !== null) return null;
      const value = flag.slice("--protected-reference=".length);
      if (value !== "integration" && value !== "production") return null;
      protectedReferenceEnvironment = value;
      continue;
    }
    if (flag.startsWith("--commit=")) {
      if (commit !== null) return null;
      const value = flag.slice("--commit=".length);
      if (!/^[0-9a-f]{40}$/u.test(value)) return null;
      commit = value;
      continue;
    }
    if (flag.startsWith("--generation=")) {
      if (generation !== null) return null;
      const value = flag.slice("--generation=".length);
      if (!/^[0-9a-f]{32}$/u.test(value)) return null;
      generation = value;
      continue;
    }
    if (flag.startsWith("--fresh-lineage=")) {
      if (freshLineage !== null) return null;
      if (flag === "--fresh-lineage=v2-artifacts-0075") freshLineage = "v2-artifacts-0075";
      else if (flag === "--fresh-lineage=v2-0088") freshLineage = "v2-0088";
      else if (flag === "--fresh-lineage=v2-0089") freshLineage = "v2-0089";
      else if (flag === "--fresh-lineage=v2-0091") freshLineage = "v2-0091";
      else if (flag === "--fresh-lineage=v2-0092") freshLineage = "v2-0092";
      else if (flag === "--fresh-lineage=v2-0100") freshLineage = "v2-0100";
      else if (flag === "--fresh-lineage=v2-0100-money-preserved")
        freshLineage = "v2-0100-money-preserved";
      else return null;
      continue;
    }
    if (flag.startsWith("--rebind-state-database-from=")) {
      if (predecessorStateDatabaseId !== null) return null;
      const value = flag.slice("--rebind-state-database-from=".length);
      if (!STORAGE_REBIND_UUID.test(value)) return null;
      predecessorStateDatabaseId = value;
      continue;
    }
    if (flag.startsWith("--rebind-object-bucket-from=")) {
      if (predecessorObjectBucketName !== null) return null;
      const value = flag.slice("--rebind-object-bucket-from=".length);
      if (!STORAGE_REBIND_BUCKET.test(value)) return null;
      predecessorObjectBucketName = value;
      continue;
    }
    if (flag.startsWith("--legacy-predecessor-version=")) {
      if (
        legacyPredecessorVersionId !== null ||
        legacyHostRuntimePredecessorVersionId !== null ||
        closurePredecessorVersionId !== null
      ) {
        return null;
      }
      const value = flag.slice("--legacy-predecessor-version=".length);
      if (!isWorkerVersionId(value)) return null;
      legacyPredecessorVersionId = value;
      continue;
    }
    if (flag.startsWith("--legacy-host-runtime-predecessor-version=")) {
      if (
        legacyHostRuntimePredecessorVersionId !== null ||
        legacyPredecessorVersionId !== null ||
        closurePredecessorVersionId !== null
      ) {
        return null;
      }
      const value = flag.slice("--legacy-host-runtime-predecessor-version=".length);
      if (!isWorkerVersionId(value)) return null;
      legacyHostRuntimePredecessorVersionId = value;
      continue;
    }
    if (flag.startsWith("--closure-predecessor-version=")) {
      if (
        closurePredecessorVersionId !== null ||
        legacyPredecessorVersionId !== null ||
        legacyHostRuntimePredecessorVersionId !== null
      ) {
        return null;
      }
      const value = flag.slice("--closure-predecessor-version=".length);
      if (!isWorkerVersionId(value)) return null;
      closurePredecessorVersionId = value;
      continue;
    }
    const deltaFlag = closureDeltaFlag(flag);
    if (deltaFlag !== null) {
      if (!CLOSURE_DELTA_NAME.test(deltaFlag.name)) return null;
      const list =
        deltaFlag.kind === "retire-var"
          ? retireVars
          : deltaFlag.kind === "add-var"
            ? addVars
            : deltaFlag.kind === "refresh-var"
              ? refreshVars
              : deltaFlag.kind === "refresh-service-binding"
                ? refreshServiceBindings
                : deltaFlag.kind === "add-binding"
                  ? addBindings
                  : deltaFlag.kind === "add-secret"
                    ? addSecrets
                    : rotateSecrets;
      list.push(deltaFlag.name);
      continue;
    }
    if (flag.startsWith("--unattributed-successor-version=")) {
      if (unattributedSuccessorVersionId !== null) return null;
      const value = flag.slice("--unattributed-successor-version=".length);
      if (!isWorkerVersionId(value)) return null;
      unattributedSuccessorVersionId = value;
      continue;
    }
    if (flag.startsWith("--form-authority-scope-transition=")) {
      if (formAuthorityScopeTransitionPath !== null) return null;
      const value = flag.slice("--form-authority-scope-transition=".length);
      if (!value || !isAbsolute(value)) return null;
      formAuthorityScopeTransitionPath = value;
      continue;
    }
    if (flag.startsWith("--adopt-live=")) {
      if (adoptLivePath !== null) return null;
      const value = flag.slice("--adopt-live=".length);
      if (!value || !isAbsolute(value)) return null;
      adoptLivePath = value;
      continue;
    }
    if (flag === "--bootstrap-verifier-bridge") {
      if (bootstrapVerifierBridge) return null;
      bootstrapVerifierBridge = true;
      continue;
    }
    if (flag.startsWith("--bootstrap-probe-predecessor-version=")) {
      if (bootstrapProbePredecessorVersionId !== null) return null;
      const value = flag.slice("--bootstrap-probe-predecessor-version=".length);
      if (!isWorkerVersionId(value)) return null;
      bootstrapProbePredecessorVersionId = value;
      continue;
    }
    if (flag.startsWith("--through-migration=")) {
      if (throughMigration !== null) return null;
      const value = flag.slice("--through-migration=".length);
      if (
        value === "0098" ||
        value === "0100" ||
        value === "0103" ||
        value === "0104" ||
        value === "0105" ||
        value === "0106" ||
        value === "0107"
      ) {
        throughMigration = value;
      } else {
        if (!SCHEMA_WAVE_BOUNDARIES.includes(value as SchemaWaveBoundary)) return null;
        throughMigration = value as SchemaWaveBoundary;
      }
      continue;
    }
    if (flag === "--reverse") {
      if (reverse) return null;
      reverse = true;
      continue;
    }
    return null;
  }
  if (!action || !environment || !commit) return null;
  if (
    repairOriginalMoneyMaintenance &&
    (surfaceValue !== "takoserver-integration-worker-bootstrap" ||
      action !== "apply" ||
      environment !== "integration" ||
      args.length !== 5)
  )
    return null;
  const hostRetirement = surfaceValue === "takoserver-integration-host-retirement";
  const retirementOperands = [retiredTargetPath, retiredDeploymentId, retiredVersionId].filter(
    (value) => value !== null,
  ).length;
  if (
    hostRetirement
      ? retirementOperands !== 3 ||
        environment !== "integration" ||
        args.length !== 7 ||
        (action !== "status" && action !== "apply")
      : retirementOperands !== 0
  ) {
    return null;
  }
  if (
    hostRetirement &&
    retiredTargetPath !== null &&
    retiredDeploymentId !== null &&
    retiredVersionId !== null &&
    (action === "status" || action === "apply")
  ) {
    return {
      surface: "takoserver-integration-host-retirement",
      action,
      environment,
      commit,
      retiredTargetPath,
      retiredDeploymentId,
      retiredVersionId,
    };
  }
  if (
    (surfaceValue === "takoserver-integration-worker-bootstrap" ||
      surfaceValue === "takoserver-integration-organization-bootstrap") &&
    (environment !== "integration" ||
      args.length !== (repairOriginalMoneyMaintenance ? 5 : 4) ||
      (action !== "status" && action !== "apply"))
  )
    return null;
  if (
    surfaceValue === "takoserver-integration-storage-disposal" &&
    (environment !== "integration" ||
      args.length !== 4 ||
      (action !== "status" && action !== "apply"))
  ) {
    return null;
  }
  const storageGeneration = surfaceValue === "takoserver-integration-storage-generation";
  const productionFreshInit = surfaceValue === "takoserver-production-d1-fresh-init";
  if (
    // v2-0091, v2-0092, v2-0100 and v2-0100-money-preserved are staging-only:
    // production fresh init never accepts them, so they cannot fall back to its
    // default payload either.
    (productionFreshInit &&
      (freshLineage === "v2-artifacts-0075" ||
        freshLineage === "v2-0091" ||
        freshLineage === "v2-0092" ||
        freshLineage === "v2-0100" ||
        freshLineage === "v2-0100-money-preserved")) ||
    (freshLineage !== null && !storageGeneration && !productionFreshInit)
  )
    return null;
  if ((generation !== null) !== (storageGeneration || productionFreshInit)) return null;
  // The epoch record directory belongs only to the Money-preserved generation.
  if (
    epochRecordDirectory !== null &&
    (!storageGeneration || freshLineage !== "v2-0100-money-preserved")
  )
    return null;
  if (
    storageGeneration &&
    (environment !== "integration" ||
      args.length !==
        5 + (freshLineage === null ? 0 : 1) + (epochRecordDirectory === null ? 0 : 1) ||
      (action !== "status" && action !== "apply"))
  ) {
    return null;
  }
  if (productionFreshInit) {
    return environment === "production" &&
      (action === "status" || action === "apply") &&
      generation !== null &&
      args.length === (freshLineage === null ? 5 : 6)
      ? {
          surface: surfaceValue,
          action,
          environment,
          commit,
          generation,
          ...(freshLineage === "v2-0088" || freshLineage === "v2-0089" ? { freshLineage } : {}),
        }
      : null;
  }
  const closureDeltaNames = [
    ...retireVars,
    ...addVars,
    ...refreshVars,
    ...refreshServiceBindings,
    ...addBindings,
    ...addSecrets,
    ...rotateSecrets,
  ];
  const storageRebindFlagCount =
    (predecessorStateDatabaseId === null ? 0 : 1) + (predecessorObjectBucketName === null ? 0 : 1);
  if ((predecessorStateDatabaseId === null) !== (predecessorObjectBucketName === null)) {
    return null;
  }
  const storageRebind = predecessorStateDatabaseId !== null;
  const hasClosureDelta = closureDeltaNames.length > 0 || storageRebind;
  const orgApiKey = surfaceValue === "takoserver-org-api-key";
  const operatorIdentity =
    surfaceValue === "takoserver-operator-identity" ||
    surfaceValue === "takoserver-integration-operator-identity";
  const orgApiKeyOperands =
    (organizationId === null ? 0 : 1) +
    (keyName === null ? 0 : 1) +
    scopes.length +
    (expiresInDays === null ? 0 : 1) +
    (apiKeyId === null ? 0 : 1);
  // Every key operand belongs to exactly one surface, and that surface needs
  // exactly one of them for each thing it is being asked to name.
  if (!orgApiKey && !operatorIdentity && orgApiKeyOperands > 0) return null;
  if (orgApiKey) {
    if (
      organizationId === null ||
      orgApiKeyOperands > MAX_ORG_API_KEY_FLAGS ||
      closureDeltaNames.length > 0 ||
      storageRebind ||
      closurePredecessorVersionId !== null ||
      legacyPredecessorVersionId !== null ||
      legacyHostRuntimePredecessorVersionId !== null ||
      unattributedSuccessorVersionId !== null ||
      formAuthorityScopeTransitionPath !== null ||
      adoptLivePath !== null ||
      bootstrapVerifierBridge ||
      bootstrapProbePredecessorVersionId !== null ||
      throughMigration !== null ||
      reverse ||
      (action !== "mint" && action !== "status" && action !== "revoke")
    ) {
      return null;
    }
    if (action === "mint" && (keyName === null || scopes.length === 0 || expiresInDays === null)) {
      return null;
    }
    if (action !== "mint" && (keyName !== null || scopes.length > 0 || expiresInDays !== null)) {
      return null;
    }
    if ((action === "revoke") !== (apiKeyId !== null)) return null;
    return {
      surface: surfaceValue,
      action,
      environment,
      commit,
      organizationId,
      ...(keyName === null ? {} : { keyName }),
      ...(scopes.length === 0 ? {} : { scopes: [...scopes].sort() }),
      ...(expiresInDays === null ? {} : { expiresInDays }),
      ...(apiKeyId === null ? {} : { apiKeyId }),
    } as Invocation;
  }
  if (operatorIdentity) {
    if (
      organizationId === null ||
      keyName !== null ||
      scopes.length > 0 ||
      expiresInDays !== null ||
      apiKeyId !== null ||
      closureDeltaNames.length > 0 ||
      storageRebind ||
      closurePredecessorVersionId !== null ||
      legacyPredecessorVersionId !== null ||
      legacyHostRuntimePredecessorVersionId !== null ||
      unattributedSuccessorVersionId !== null ||
      formAuthorityScopeTransitionPath !== null ||
      adoptLivePath !== null ||
      bootstrapVerifierBridge ||
      bootstrapProbePredecessorVersionId !== null ||
      throughMigration !== null ||
      reverse ||
      (action !== "status" && action !== "apply")
    ) {
      return null;
    }
    if (
      surfaceValue === "takoserver-integration-operator-identity" &&
      environment !== "integration"
    ) {
      return null;
    }
    return {
      surface: surfaceValue,
      action,
      environment,
      commit,
      organizationId,
    } as Invocation;
  }
  if (action === "mint") return null;
  if (surfaceValue === "takoserver-rehearsal-d1-create") {
    return environment === "rehearsal" &&
      (action === "status" || action === "apply") &&
      args.length === 4
      ? { surface: surfaceValue, action, environment, commit }
      : null;
  }
  if (surfaceValue === "takoserver-d1-money-cutover-rehearsal") {
    return environment === "rehearsal" &&
      (action === "status" || action === "apply") &&
      args.length === 4
      ? { surface: surfaceValue, action, environment, commit }
      : null;
  }
  if (
    surfaceValue === "takoserver-integration-money-shadow-create" ||
    surfaceValue === "takoserver-integration-money-shadow-rehearsal" ||
    surfaceValue === "takoserver-integration-money-shadow-native-probe"
  ) {
    return environment === "integration" &&
      (action === "status" || action === "apply") &&
      args.length === 4
      ? { surface: surfaceValue, action, environment, commit }
      : null;
  }
  if (surfaceValue === "takoserver-d1-snapshot-restore") {
    return environment === "rehearsal" &&
      (action === "status" || action === "apply") &&
      args.length === 4
      ? { surface: surfaceValue, action, environment, commit }
      : null;
  }
  const budget =
    6 +
    (adoptLivePath === null ? 0 : 1) +
    (bootstrapVerifierBridge ? 1 : 0) +
    (epochRecordDirectory === null ? 0 : 1);
  if (closurePredecessorVersionId === null) {
    // Every other invocation keeps the historical exact flag budget.
    if (args.length > budget || hasClosureDelta) return null;
  } else if (
    !TRANSITION_SURFACES.includes(surfaceValue) ||
    reverse ||
    !hasClosureDelta ||
    closureDeltaNames.length > MAX_CLOSURE_DELTA_FLAGS ||
    storageRebindFlagCount > MAX_STORAGE_REBIND_FLAGS ||
    args.length > budget + MAX_CLOSURE_DELTA_FLAGS + MAX_STORAGE_REBIND_FLAGS ||
    new Set(closureDeltaNames).size !== closureDeltaNames.length
  ) {
    return null;
  }
  if (
    storageRebind &&
    (environment !== "integration" || !STORAGE_REBIND_SURFACES.includes(surfaceValue))
  ) {
    return null;
  }
  if (refreshServiceBindings.length > 0 && environment !== "integration") return null;
  // The candidate descriptor is a readback product; it never accompanies a
  // mutation, so the surface can never be asked to adopt and publish at once.
  if (
    surfaceValue === "takoserver-d1-schema-rehearsal-baseline" &&
    (environment !== "rehearsal" || throughMigration !== null)
  ) {
    return null;
  }
  if (
    surfaceValue === "takoserver-d1-schema-0058-rehearsal" &&
    (environment !== "rehearsal" || throughMigration !== null)
  ) {
    return null;
  }
  if (
    protectedReferenceEnvironment !== null &&
    (surfaceValue !== "takoserver-d1-schema-0058-rehearsal" || args.length !== 5)
  ) {
    return null;
  }
  if (
    surfaceValue === "takoserver-d1-schema" &&
    environment !== "integration" &&
    throughMigration === null
  ) {
    return null;
  }
  if (
    (throughMigration === "0098" ||
      throughMigration === "0100" ||
      throughMigration === "0103" ||
      throughMigration === "0104" ||
      throughMigration === "0105" ||
      throughMigration === "0106" ||
      throughMigration === "0107") &&
    (surfaceValue !== "takoserver-d1-schema" || environment !== "integration")
  ) {
    return null;
  }
  if (
    (throughMigration === "0093" || throughMigration === "0094") &&
    environment !== "integration"
  ) {
    return null;
  }
  if (
    surfaceValue !== "takoserver-d1-schema" &&
    surfaceValue !== "takoserver-d1-schema-rehearsal-baseline" &&
    surfaceValue !== "takoserver-d1-schema-0058-rehearsal" &&
    throughMigration !== null
  ) {
    return null;
  }
  if (
    adoptLivePath !== null &&
    (!ADOPT_LIVE_SURFACES.includes(surfaceValue) || action !== "status")
  ) {
    return null;
  }
  // The bootstrap deferral belongs to exactly one surface's one mutating
  // action. Its own Worker has no predecessor, but the identity probe must have
  // one explicitly pinned predecessor which is inspected by that surface's
  // strict one-binding transition classifier.
  if (
    bootstrapVerifierBridge !== (bootstrapProbePredecessorVersionId !== null) ||
    (bootstrapVerifierBridge &&
      (surfaceValue !== "takoserver-form-authority-worker" ||
        action !== "apply" ||
        closurePredecessorVersionId !== null ||
        formAuthorityScopeTransitionPath !== null ||
        adoptLivePath !== null ||
        reverse))
  ) {
    return null;
  }
  if (
    (surfaceValue === "takoserver-integration-e2e-credentials" && action === "apply") ||
    (surfaceValue !== "takoserver-integration-e2e-credentials" &&
      (action === "issue" || action === "revoke"))
  ) {
    return null;
  }
  if (
    (surfaceValue === "takoserver-integration-form-authority-worker" ||
      surfaceValue === "takoserver-integration-form-authority-operator-worker" ||
      surfaceValue === "takoserver-integration-form-authority" ||
      surfaceValue === "takoserver-integration-form-authority-deactivation" ||
      surfaceValue === "takoserver-integration-e2e-credentials") &&
    environment !== "integration"
  ) {
    return null;
  }
  if (
    legacyPredecessorVersionId !== null &&
    (surfaceValue !== "takoserver-worker-authority-cutover" || environment !== "integration")
  ) {
    return null;
  }
  if (
    legacyHostRuntimePredecessorVersionId !== null &&
    (!(
      surfaceValue === "takoserver-sponsorship-public-route-retirement" ||
      surfaceValue === "takoserver-host-runtime-topology-retirement" ||
      surfaceValue === "takoserver-hosted-token-retirement" ||
      surfaceValue === "takoserver-worker-retirement-attribution-repair"
    ) ||
      (environment !== "integration" && environment !== "production"))
  ) {
    return null;
  }
  if (
    legacyHostRuntimePredecessorVersionId === null &&
    (surfaceValue === "takoserver-sponsorship-public-route-retirement" ||
      surfaceValue === "takoserver-host-runtime-topology-retirement" ||
      surfaceValue === "takoserver-hosted-token-retirement" ||
      surfaceValue === "takoserver-worker-retirement-attribution-repair")
  ) {
    return null;
  }
  if (
    unattributedSuccessorVersionId !== null &&
    surfaceValue !== "takoserver-worker-retirement-attribution-repair"
  ) {
    return null;
  }
  if (
    surfaceValue === "takoserver-worker-retirement-attribution-repair" &&
    unattributedSuccessorVersionId === null
  ) {
    return null;
  }
  if (
    formAuthorityScopeTransitionPath !== null &&
    (environment !== "integration" ||
      !(
        surfaceValue === "takoserver-integration-form-authority-worker" ||
        surfaceValue === "takoserver-integration-form-authority-operator-worker" ||
        surfaceValue === "takoserver-integration-form-authority-deactivation"
      ) ||
      reverse)
  ) {
    return null;
  }
  if (
    reverse &&
    !(
      surfaceValue === "takoserver-sponsorship-public-route-retirement" ||
      surfaceValue === "takoserver-host-runtime-topology-retirement"
    )
  ) {
    return null;
  }
  if (reverse && action !== "apply") return null;
  if (
    reverse &&
    surfaceValue === "takoserver-sponsorship-public-route-retirement" &&
    legacyHostRuntimePredecessorVersionId === null
  ) {
    return null;
  }
  return {
    surface: surfaceValue,
    action,
    environment,
    commit,
    ...(legacyPredecessorVersionId === null ? {} : { legacyPredecessorVersionId }),
    ...(legacyHostRuntimePredecessorVersionId === null
      ? {}
      : { legacyHostRuntimePredecessorVersionId }),
    ...(closurePredecessorVersionId === null
      ? {}
      : {
          closurePredecessorVersionId,
          closureDelta: {
            retiredVars: [...retireVars].sort(),
            addedVars: [...addVars].sort(),
            refreshedVars: [...refreshVars].sort(),
            ...(refreshServiceBindings.length === 0
              ? {}
              : { refreshedServiceBindings: [...refreshServiceBindings].sort() }),
            addedBindings: [...addBindings].sort(),
            addedSecrets: [...addSecrets].sort(),
            rotatedSecrets: [...rotateSecrets].sort(),
            ...(storageRebind
              ? {
                  storageRebind: {
                    predecessorStateDatabaseId: predecessorStateDatabaseId as string,
                    predecessorObjectBucketName: predecessorObjectBucketName as string,
                  },
                }
              : {}),
          },
        }),
    ...(unattributedSuccessorVersionId === null ? {} : { unattributedSuccessorVersionId }),
    ...(formAuthorityScopeTransitionPath === null ? {} : { formAuthorityScopeTransitionPath }),
    ...(adoptLivePath === null ? {} : { adoptLivePath }),
    ...(bootstrapVerifierBridge ? { bootstrapVerifierBridge: true } : {}),
    ...(repairOriginalMoneyMaintenance ? { repairOriginalMoneyMaintenance: true } : {}),
    ...(bootstrapProbePredecessorVersionId === null ? {} : { bootstrapProbePredecessorVersionId }),
    ...(throughMigration === null ? {} : { throughMigration }),
    ...(protectedReferenceEnvironment === null ? {} : { protectedReferenceEnvironment }),
    ...(generation === null ? {} : { generation }),
    ...(freshLineage === null ? {} : { freshLineage }),
    ...(epochRecordDirectory === null ? {} : { epochRecordDirectory }),
    ...(reverse ? { reverse: true } : {}),
  } as Invocation;
}

type ClosureDeltaFlagKind =
  | "retire-var"
  | "add-var"
  | "refresh-var"
  | "refresh-service-binding"
  | "add-binding"
  | "add-secret"
  | "rotate-secret";

function closureDeltaFlag(
  flag: string,
): { readonly kind: ClosureDeltaFlagKind; readonly name: string } | null {
  for (const kind of [
    "retire-var",
    "add-var",
    "refresh-var",
    "refresh-service-binding",
    "add-binding",
    "add-secret",
    "rotate-secret",
  ] as const) {
    const prefix = `--${kind}=`;
    if (flag.startsWith(prefix)) return { kind, name: flag.slice(prefix.length) };
  }
  return null;
}

function isSurface(value: string | undefined): value is Surface {
  return DEPLOY_CONTRACT.surfaces.some(({ surface }) => surface === value);
}

function loadRehearsalD1CreateDeclaration(): RehearsalD1CreateDeclaration {
  return loadOwnedDeclaration<RehearsalD1CreateDeclaration>(
    "TAKOSERVER_REHEARSAL_D1_CREATE_DECLARATION_PATH",
    "rehearsal D1 declaration",
  );
}

/**
 * Reads one operator-owned declaration. Both surfaces that own a D1 identity by
 * declaration (rehearsal creation and snapshot restore) share these exact file
 * rules: absolute link-free single-link 0600, current owner, bounded size.
 */
function loadOwnedDeclaration<T>(environmentVariable: string, label: string): T {
  const path = requireEnvironment(environmentVariable);
  if (!isAbsolute(path) || /[\0\r\n]/u.test(path)) {
    throw new DeployError("preflight", `${label} path must be absolute`);
  }
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    throw new DeployError("preflight", `${label} could not be opened`);
  }
  try {
    const status = fstatSync(fd);
    if (
      !status.isFile() ||
      status.nlink !== 1 ||
      status.uid !== process.getuid?.() ||
      (status.mode & 0o077) !== 0 ||
      status.size > 4096
    ) {
      throw new DeployError("preflight", `${label} must be owned 0600 regular file`);
    }
    const parsed: unknown = JSON.parse(readFileSync(fd, "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new DeployError("preflight", `${label} must be a JSON object`);
    }
    return parsed as T;
  } catch (error) {
    if (error instanceof DeployError) throw error;
    throw new DeployError("preflight", `${label} is invalid JSON`);
  } finally {
    closeSync(fd);
  }
}

function loadD1SnapshotRestoreDeclaration(): D1SnapshotRestoreDeclaration {
  return loadOwnedDeclaration<D1SnapshotRestoreDeclaration>(
    "TAKOSERVER_D1_SNAPSHOT_RESTORE_DECLARATION_PATH",
    "snapshot restore declaration",
  );
}

function loadMoneyRehearsalDeclaration(): MoneyRehearsalDeclaration {
  return loadOwnedDeclaration<MoneyRehearsalDeclaration>(
    "TAKOSERVER_D1_MONEY_REHEARSAL_DECLARATION_PATH",
    "money cutover rehearsal declaration",
  );
}

function loadMoneyShadowCreateDeclaration(): IntegrationMoneyShadowCreateDeclaration {
  return loadOwnedDeclaration<IntegrationMoneyShadowCreateDeclaration>(
    "TAKOSERVER_INTEGRATION_MONEY_SHADOW_CREATE_DECLARATION_PATH",
    "integration money shadow create declaration",
  );
}

function loadMoneyShadowRehearsalDeclaration(): IntegrationMoneyShadowRehearsalDeclaration {
  return loadOwnedDeclaration<IntegrationMoneyShadowRehearsalDeclaration>(
    "TAKOSERVER_INTEGRATION_MONEY_SHADOW_REHEARSAL_DECLARATION_PATH",
    "integration money shadow rehearsal declaration",
  );
}

function loadMoneyShadowNativeProbeDeclaration(): MoneyShadowNativeProbeDeclaration {
  return loadOwnedDeclaration<MoneyShadowNativeProbeDeclaration>(
    "TAKOSERVER_INTEGRATION_MONEY_SHADOW_NATIVE_PROBE_DECLARATION_PATH",
    "integration money shadow native probe declaration",
  );
}

async function dispatch(invocation: Invocation): Promise<Record<string, unknown>> {
  const originalCreateInput = process.env.TAKOSERVER_INTEGRATION_STORAGE_ORIGINAL_CREATE_INPUT_PATH;
  if (
    process.env.TAKOSERVER_INTEGRATION_MONEY_MAINTENANCE_REPAIR_SELECTION_PATH !== undefined &&
    invocation.repairOriginalMoneyMaintenance !== true
  )
    throw new DeployError(
      "preflight",
      "original money maintenance repair selection requires --repair-original-money-maintenance",
    );
  if (invocation.repairOriginalMoneyMaintenance === true) {
    const originalCreateInputPath = requireEnvironment(
      "TAKOSERVER_INTEGRATION_STORAGE_ORIGINAL_CREATE_INPUT_PATH",
    );
    const selectionPath = requireEnvironment(
      "TAKOSERVER_INTEGRATION_MONEY_MAINTENANCE_SELECTION_PATH",
    );
    const repairSelectionPath = requireEnvironment(
      "TAKOSERVER_INTEGRATION_MONEY_MAINTENANCE_REPAIR_SELECTION_PATH",
    );
    const target = loadTarget(
      targetPath("integration"),
      "integration",
      "money-original-maintenance-bootstrap",
    );
    return await runIntegrationWorkerBootstrap(
      {
        action: "apply",
        environment: "integration",
        commit: invocation.commit,
        surface: "takoserver-integration-worker-bootstrap",
      },
      target,
      {
        originalMoneyMaintenanceRepair: {
          originalCreateInputPath,
          selectionPath,
          repairSelectionPath,
        },
      },
    );
  }
  if (
    process.env.TAKOSERVER_INTEGRATION_MONEY_MAINTENANCE_SELECTION_PATH !== undefined &&
    (originalCreateInput === undefined ||
      invocation.surface !== "takoserver-integration-worker-bootstrap" ||
      invocation.environment !== "integration")
  )
    throw new DeployError(
      "preflight",
      "original money maintenance selection is scoped to the integration first-publication route",
    );
  if (invocation.throughMigration === "0103") {
    if (invocation.environment !== "integration" || invocation.surface !== "takoserver-d1-schema")
      throw new DeployError("preflight", "0103 source registration is integration-only");
    const target = loadTarget(targetPath("integration"), "integration");
    const production = loadTarget(
      requireEnvironment("TAKOSERVER_DEPLOY_TARGET_PRODUCTION"),
      "production",
    );
    const { runD1SchemaAuth103 } = await import("./deploy/schema-auth103-native-source.ts");
    return await runD1SchemaAuth103(
      { action: invocation.action, environment: "integration", commit: invocation.commit },
      target,
      production.d1,
    );
  }
  if (
    invocation.throughMigration === "0104" ||
    invocation.throughMigration === "0105" ||
    invocation.throughMigration === "0106" ||
    invocation.throughMigration === "0107"
  ) {
    if (invocation.environment !== "integration" || invocation.surface !== "takoserver-d1-schema")
      throw new DeployError("preflight", "post-Auth103 source registration is integration-only");
    const target = loadTarget(targetPath("integration"), "integration");
    const production = loadTarget(
      requireEnvironment("TAKOSERVER_DEPLOY_TARGET_PRODUCTION"),
      "production",
    );
    const { runD1SchemaFinancial0104 } = await import("./deploy/schema-financial0104-source.ts");
    return await runD1SchemaFinancial0104(
      {
        action: invocation.action,
        environment: "integration",
        commit: invocation.commit,
        throughMigration: invocation.throughMigration,
      },
      target,
      production.d1,
    );
  }
  if (invocation.throughMigration === "0100") {
    if (
      invocation.environment !== "integration" ||
      invocation.surface !== "takoserver-d1-schema" ||
      originalCreateInput === undefined ||
      !isAbsolute(originalCreateInput) ||
      resolve(originalCreateInput) !== originalCreateInput ||
      /[\0\r\n]/.test(originalCreateInput)
    )
      throw new DeployError(
        "preflight",
        "money original100 requires canonical original-create custody",
      );
    const locator = (name: string): string => {
      const value = requireEnvironment(name);
      if (!isAbsolute(value) || resolve(value) !== value || /[\0\r\n]/.test(value))
        throw new DeployError("preflight", `${name} must be a canonical absolute protected path`);
      return value;
    };
    const declarationPath = locator("TAKOSERVER_D1_MONEY_CUTOVER_DECLARATION_PATH");
    const post94DeclarationPath = locator("TAKOSERVER_D1_MONEY_POST94_DECLARATION_PATH");
    const originalCreate = loadIntegrationStorageOriginalCreateInput(originalCreateInput);
    const target = loadTarget(targetPath("integration"), "integration", "money-original-cutover");
    const { loadMoneyUnitOriginalCutoverOptions } = await import(
      "./deploy/schema-money-unit-owner.ts"
    );
    const { runIntegrationMoneyOriginalPreserved100 } = await import(
      "./deploy/schema-money-unit-cutover.ts"
    );
    const options = await loadMoneyUnitOriginalCutoverOptions({
      selectedTarget: target,
      declarationPath,
      originalCreate,
    });
    return await runIntegrationMoneyOriginalPreserved100(
      {
        action: invocation.action,
        environment: "integration",
        commit: invocation.commit,
        throughMigration: "0100",
      },
      target,
      options,
      post94DeclarationPath,
    );
  }
  if (invocation.throughMigration === "0098") {
    if (originalCreateInput === undefined)
      throw new DeployError(
        "preflight",
        "money held post94 status requires original-create custody",
      );
    // There is no Financial contribution yet. Status observations cannot authorize dispatch.
    if (invocation.action !== "status")
      throw new DeployError(
        "preflight",
        "money held post94 apply requires the real Financial contribution",
      );
    const locator = (name: string): string => {
      const value = requireEnvironment(name);
      if (!isAbsolute(value) || resolve(value) !== value || /[\0\r\n]/.test(value))
        throw new DeployError("preflight", `${name} must be a canonical absolute protected path`);
      return value;
    };
    // Validate every locator before loading custody or capturing the native owner.
    const declarationPath = locator("TAKOSERVER_D1_MONEY_CUTOVER_DECLARATION_PATH");
    const post94DeclarationPath = locator("TAKOSERVER_D1_MONEY_POST94_DECLARATION_PATH");
    const normalWorkerSelectorPath = locator("TAKOSERVER_D1_MONEY_NORMAL_WORKER_SELECTOR_PATH");
    if (
      !isAbsolute(originalCreateInput) ||
      resolve(originalCreateInput) !== originalCreateInput ||
      /[\0\r\n]/.test(originalCreateInput)
    )
      throw new DeployError(
        "preflight",
        "money held post94 status requires a canonical original-create custody path",
      );
    const originalCreate = loadIntegrationStorageOriginalCreateInput(originalCreateInput);
    const target = loadTarget(targetPath("integration"), "integration", "money-original-cutover");
    const { loadMoneyUnitOriginalCutoverOptions, readMoneyUnitHeldPost94ConsumerInputs } =
      await import("./deploy/schema-money-unit-owner.ts");
    const options = await loadMoneyUnitOriginalCutoverOptions({
      selectedTarget: target,
      declarationPath,
      originalCreate,
    });
    const inputs = await readMoneyUnitHeldPost94ConsumerInputs(
      options,
      post94DeclarationPath,
      normalWorkerSelectorPath,
    );
    const facts = inputs.normalWorkerModePreparation.facts;
    // Bounded DATA only: none of the opaque inputs is exposed as a deploy permission.
    return {
      surface: invocation.surface,
      action: "status",
      environment: "integration",
      commit: invocation.commit,
      throughMigration: "0098",
      observationKind: "held-post94-pre-import-data",
      observations: {
        previousWriterEpoch: facts.previousWriterEpoch,
        nextWriterEpoch: facts.nextWriterEpoch,
        heldConvertDigest: facts.heldConvertDigest,
        convertBindingDigest: facts.convertBindingDigest,
        converted94BackupDigest: facts.converted94BackupDigest,
        selectionDeclarationDigest: inputs.selection.declarationDigest,
        selectionReviewDigest: inputs.selection.selectionReviewDigest,
        normalWorkerModePreparationDigest: inputs.normalWorkerModePreparation.bindingDigest,
        versionId: facts.versionId,
        sourceCommit: facts.sourceCommit,
        moduleDigest: facts.moduleDigest,
        sourceArtifactDigest: facts.sourceArtifactDigest,
        sourceTreeDigest: facts.sourceTreeDigest,
        dependencyClosureDigest: facts.dependencyClosureDigest,
        toolClosureDigest: facts.toolClosureDigest,
        nativeBindingDigest: facts.nativeBindingDigest,
        stripeMode: facts.stripeMode,
        modeEvidence: facts.modeEvidence,
      },
    };
  }
  if (
    originalCreateInput !== undefined &&
    invocation.surface === "takoserver-d1-schema" &&
    invocation.environment === "integration" &&
    (invocation.throughMigration === "0093" || invocation.throughMigration === "0094")
  ) {
    const originalCreate = loadIntegrationStorageOriginalCreateInput(originalCreateInput);
    const target = loadTarget(targetPath("integration"), "integration", "money-original-cutover");
    const { loadMoneyUnitOriginalCutoverOptions } = await import(
      "./deploy/schema-money-unit-owner.ts"
    );
    const options = await loadMoneyUnitOriginalCutoverOptions({
      selectedTarget: target,
      declarationPath: requireEnvironment("TAKOSERVER_D1_MONEY_CUTOVER_DECLARATION_PATH"),
      originalCreate,
    });
    const result = await runD1Schema(
      {
        action: invocation.action,
        environment: "integration",
        commit: invocation.commit,
        throughMigration: invocation.throughMigration,
      },
      target,
      { moneyUnitCutover: options },
    );
    return { ...result, originalOriginQualification: options.originalOriginQualification };
  }
  if (
    originalCreateInput !== undefined &&
    invocation.surface === "takoserver-integration-worker-bootstrap" &&
    invocation.environment === "integration"
  ) {
    const target = loadTarget(
      targetPath("integration"),
      "integration",
      "money-original-maintenance-bootstrap",
    );
    return await runIntegrationWorkerBootstrap(
      {
        action: invocation.action,
        environment: "integration",
        commit: invocation.commit,
        surface: "takoserver-integration-worker-bootstrap",
      },
      target,
      {
        originalMoneyMaintenance: {
          originalCreateInputPath: originalCreateInput,
          selectionPath: requireEnvironment(
            "TAKOSERVER_INTEGRATION_MONEY_MAINTENANCE_SELECTION_PATH",
          ),
        },
      },
    );
  }
  if (originalCreateInput !== undefined) {
    if (
      invocation.surface !== "takoserver-integration-storage-generation" ||
      invocation.environment !== "integration" ||
      invocation.freshLineage !== "v2-0092"
    ) {
      throw new DeployError(
        "preflight",
        "original-create input is supported only for integration storage generation with --fresh-lineage=v2-0092",
      );
    }
    const originalCreate = loadIntegrationStorageOriginalCreateInput(originalCreateInput);
    const target = loadTarget(targetPath("integration"), "integration");
    const selected: IntegrationStorageGenerationInvocation = {
      action: invocation.action,
      environment: "integration",
      commit: invocation.commit,
      generation: invocation.generation,
      namespace: "integration-ts",
      freshLineage: "v2-0092",
    };
    return await runIntegrationStorageGeneration(selected, target, { originalCreate });
  }
  if (invocation.surface === "takoserver-integration-money-shadow-native-probe") {
    return await runIntegrationMoneyShadowNativeProbe(
      loadMoneyShadowNativeProbeDeclaration(),
      invocation,
    );
  }
  if (invocation.surface === "takoserver-integration-money-shadow-create") {
    return await runIntegrationMoneyShadowCreate(loadMoneyShadowCreateDeclaration(), invocation);
  }
  if (invocation.surface === "takoserver-integration-money-shadow-rehearsal") {
    return await runIntegrationMoneyShadowRehearsal(
      loadMoneyShadowRehearsalDeclaration(),
      invocation,
    );
  }
  if (invocation.surface === "takoserver-d1-money-cutover-rehearsal") {
    return await runMoneyUnitRehearsal(loadMoneyRehearsalDeclaration(), invocation);
  }
  if (invocation.surface === "takoserver-rehearsal-d1-create") {
    return await runRehearsalD1Create(loadRehearsalD1CreateDeclaration(), invocation);
  }
  if (invocation.surface === "takoserver-d1-snapshot-restore") {
    return await runD1SnapshotRestore(loadD1SnapshotRestoreDeclaration(), invocation);
  }
  const target = loadTarget(targetPath(invocation.environment), invocation.environment);
  const scopeTransition =
    invocation.formAuthorityScopeTransitionPath === undefined
      ? undefined
      : loadFormAuthorityScopeTransition(invocation.formAuthorityScopeTransitionPath, target);
  // One declaration, read the same way for every Worker-publishing surface.
  const surfaceTransition: WorkerSurfaceTransition | undefined =
    invocation.closurePredecessorVersionId === undefined || invocation.closureDelta === undefined
      ? undefined
      : {
          predecessorVersionId: invocation.closurePredecessorVersionId,
          delta: invocation.closureDelta,
        };
  switch (invocation.surface) {
    case "takoserver-worker":
    case "takoserver-worker-authority-cutover":
      if (
        invocation.surface === "takoserver-worker-authority-cutover" &&
        invocation.closurePredecessorVersionId !== undefined &&
        invocation.closureDelta !== undefined
      ) {
        return await runWorkerClosureTransition(
          {
            surface: invocation.surface,
            action: invocation.action,
            environment: invocation.environment,
            commit: invocation.commit,
            closurePredecessorVersionId: invocation.closurePredecessorVersionId,
            delta: invocation.closureDelta,
          },
          target,
        );
      }
      return await runWorker(
        {
          surface: invocation.surface,
          action: invocation.action,
          environment: invocation.environment,
          commit: invocation.commit,
          ...(invocation.legacyPredecessorVersionId === undefined
            ? {}
            : { legacyPredecessorVersionId: invocation.legacyPredecessorVersionId }),
        },
        target,
      );
    case "takoserver-site":
      return await runStaticSite(invocation, { accountId: target.accountId });
    case "takoserver-console":
      return await runConsole(invocation, target);
    case "takoserver-d1-schema-rehearsal-baseline":
      return await runD1SchemaRehearsalBaseline(invocation, target);
    case "takoserver-d1-schema-0058-rehearsal":
      if (invocation.protectedReferenceEnvironment === undefined)
        return await runD1Schema0058Rehearsal(invocation, target);
      {
        const referenceEnvironment = invocation.protectedReferenceEnvironment;
        const referencePath = requireEnvironment(
          `TAKOSERVER_DEPLOY_TARGET_${referenceEnvironment.toUpperCase()}`,
        );
        if (!isAbsolute(referencePath))
          throw new DeployError(
            "preflight",
            "0058 protected reference target path must be absolute",
          );
        const referenceTarget = loadTarget(referencePath, referenceEnvironment);
        const referenceToken = requireEnvironment("TAKOSERVER_D1_0058_REFERENCE_API_TOKEN");
        return await runD1Schema0058Rehearsal(invocation, target, {
          protectedReference: {
            environment: referenceEnvironment,
            target: referenceTarget,
            cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: referenceToken },
          },
        });
      }
    case "takoserver-integration-storage-generation": {
      // The production target is read only for its D1 identity, which the
      // staging generation must never be. Set, it must load; unset, the
      // staging-only v2-0091/v2-0092/v2-0100/v2-0100-money-preserved apply refuses.
      const productionPath = process.env.TAKOSERVER_DEPLOY_TARGET_PRODUCTION?.trim();
      if (productionPath !== undefined && productionPath !== "" && !isAbsolute(productionPath)) {
        throw new DeployError(
          "preflight",
          "TAKOSERVER_DEPLOY_TARGET_PRODUCTION must be an absolute path",
        );
      }
      const production =
        productionPath === undefined || productionPath === ""
          ? undefined
          : loadTarget(productionPath, "production");
      return await runIntegrationStorageGeneration(invocation, target, {
        ...(production === undefined ? {} : { productionD1: production.d1 }),
        ...(invocation.epochRecordDirectory === undefined
          ? {}
          : { epochRecordDirectory: invocation.epochRecordDirectory }),
      });
    }
    case "takoserver-production-d1-fresh-init":
      return await runProductionD1FreshInit(
        {
          action: invocation.action,
          environment: invocation.environment,
          commit: invocation.commit,
          generation: invocation.generation,
          ...(invocation.freshLineage === undefined
            ? {}
            : { freshLineage: invocation.freshLineage }),
        } satisfies ProductionD1FreshInitInvocation,
        target,
      );
    case "takoserver-integration-storage-disposal":
      return await runIntegrationStorageDisposal(invocation, target);
    case "takoserver-integration-host-retirement":
      return await runIntegrationHostRetirement(invocation, target);
    case "takoserver-integration-worker-bootstrap": {
      // Only a fresh v2-0100-money-preserved first Host reads this locator.
      const freshMoneyWriterEpochRecordPath =
        process.env.TAKOSERVER_FRESH_MONEY_WRITER_EPOCH_RECORD_PATH;
      return await runIntegrationWorkerBootstrap(
        { ...invocation, surface: "takoserver-integration-worker-bootstrap" },
        target,
        freshMoneyWriterEpochRecordPath === undefined ? {} : { freshMoneyWriterEpochRecordPath },
      );
    }
    case "takoserver-d1-schema": {
      if (invocation.throughMigration === "0093" || invocation.throughMigration === "0094") {
        if (invocation.environment !== "integration") {
          throw new DeployError("preflight", "0093/0094 monetary waves are integration-only");
        }
        const { loadMoneyUnitCutoverOptions } = await import("./deploy/schema-money-unit-owner.ts");
        const options = await loadMoneyUnitCutoverOptions(
          requireEnvironment("TAKOSERVER_D1_MONEY_CUTOVER_DECLARATION_PATH"),
          target,
        );
        return await runD1Schema(
          {
            action: invocation.action,
            environment: "integration",
            commit: invocation.commit,
            throughMigration: invocation.throughMigration,
          },
          target,
          { moneyUnitCutover: options },
        );
      }
      const productionPath = process.env.TAKOSERVER_DEPLOY_TARGET_PRODUCTION?.trim();
      if (
        invocation.throughMigration === "0092" &&
        (!productionPath || !isAbsolute(productionPath))
      ) {
        throw new DeployError(
          "preflight",
          "0092 requires an absolute TAKOSERVER_DEPLOY_TARGET_PRODUCTION for read-only D1 identity fencing",
        );
      }
      const production =
        invocation.throughMigration !== "0092" ||
        productionPath === undefined ||
        productionPath === ""
          ? undefined
          : loadTarget(productionPath, "production");
      return await runD1Schema(
        {
          action: invocation.action,
          environment: invocation.environment,
          commit: invocation.commit,
          ...(invocation.throughMigration === undefined
            ? {}
            : { throughMigration: invocation.throughMigration }),
        },
        target,
        production === undefined ? {} : { productionD1: production.d1 },
      );
    }
    case "takoserver-signing-key-register":
    case "takoserver-signing-repair":
    case "takoserver-signing-rotation":
      return await runSigning(
        {
          surface: invocation.surface,
          action: invocation.action,
          environment: invocation.environment,
          commit: invocation.commit,
        },
        target,
      );
    case "takoserver-sponsorship-authority-worker":
      return await runSponsorshipAuthority(
        {
          surface: invocation.surface,
          action: invocation.action,
          environment: invocation.environment,
          commit: invocation.commit,
          ...(surfaceTransition === undefined ? {} : { transition: surfaceTransition }),
        },
        target,
      );
    case "takoserver-sponsorship-public-route-retirement":
      return await runRetirement(
        {
          surface: invocation.surface,
          action: invocation.action,
          environment: invocation.environment,
          commit: invocation.commit,
          ...(invocation.reverse ? { reverse: true } : {}),
          ...(invocation.legacyHostRuntimePredecessorVersionId === undefined
            ? {}
            : {
                legacyHostRuntimePredecessorVersionId:
                  invocation.legacyHostRuntimePredecessorVersionId,
              }),
        },
        target,
      );
    case "takoserver-host-runtime-topology-retirement":
      return await runRetirement(
        {
          surface: invocation.surface,
          action: invocation.action,
          environment: invocation.environment,
          commit: invocation.commit,
          ...(invocation.legacyHostRuntimePredecessorVersionId === undefined
            ? {}
            : {
                legacyHostRuntimePredecessorVersionId:
                  invocation.legacyHostRuntimePredecessorVersionId,
              }),
          ...(invocation.reverse ? { reverse: true } : {}),
        },
        target,
      );
    case "takoserver-hosted-token-retirement":
      return await runRetirement(
        {
          surface: invocation.surface,
          action: invocation.action,
          environment: invocation.environment,
          commit: invocation.commit,
          ...(invocation.legacyHostRuntimePredecessorVersionId === undefined
            ? {}
            : {
                legacyHostRuntimePredecessorVersionId:
                  invocation.legacyHostRuntimePredecessorVersionId,
              }),
        },
        target,
      );
    case "takoserver-worker-retirement-attribution-repair":
      return await runRetirement(
        {
          surface: invocation.surface,
          action: invocation.action,
          environment: invocation.environment,
          commit: invocation.commit,
          ...(invocation.legacyHostRuntimePredecessorVersionId === undefined
            ? {}
            : {
                legacyHostRuntimePredecessorVersionId:
                  invocation.legacyHostRuntimePredecessorVersionId,
              }),
          ...(invocation.unattributedSuccessorVersionId === undefined
            ? {}
            : { unattributedSuccessorVersionId: invocation.unattributedSuccessorVersionId }),
        },
        target,
      );
    case "takoserver-operator-identity":
    case "takoserver-integration-operator-identity":
      return await runOperatorIdentity(
        {
          surface: invocation.surface,
          action: invocation.action,
          environment: invocation.environment,
          commit: invocation.commit,
          ...(invocation.organizationId === undefined
            ? {}
            : { organizationId: invocation.organizationId }),
        },
        target,
      );
    case "takoserver-form-authority-worker":
    case "takoserver-existing-space-operator-worker":
    case "takoserver-integration-form-authority-worker":
    case "takoserver-integration-form-authority-operator-worker":
      return await runFormAuthority(
        {
          surface: invocation.surface,
          action: invocation.action,
          environment: invocation.environment,
          commit: invocation.commit,
          ...(scopeTransition === undefined ? {} : { scopeTransition }),
          ...(surfaceTransition === undefined ? {} : { transition: surfaceTransition }),
          ...(invocation.adoptLivePath === undefined
            ? {}
            : { adoptLivePath: invocation.adoptLivePath }),
          ...(invocation.bootstrapVerifierBridge === undefined
            ? {}
            : { bootstrapVerifierBridge: invocation.bootstrapVerifierBridge }),
          ...(invocation.bootstrapProbePredecessorVersionId === undefined
            ? {}
            : {
                bootstrapProbePredecessorVersionId: invocation.bootstrapProbePredecessorVersionId,
              }),
        },
        target,
      );
    case "takoserver-form-authority-identity-probe":
      return await runFormAuthorityIdentityProbe(
        {
          surface: invocation.surface,
          action: invocation.action,
          environment: invocation.environment,
          commit: invocation.commit,
          ...(surfaceTransition === undefined ? {} : { transition: surfaceTransition }),
          ...(invocation.adoptLivePath === undefined
            ? {}
            : { adoptLivePath: invocation.adoptLivePath }),
        },
        target,
      );
    case "takoserver-integration-form-authority":
    case "takoserver-integration-form-authority-deactivation":
      return await runFormAuthorityInvoke(
        {
          surface: invocation.surface,
          action: invocation.action,
          environment: invocation.environment,
          commit: invocation.commit,
          ...(scopeTransition === undefined ? {} : { scopeTransition }),
        },
        target,
      );
    case "takoserver-existing-space-reconciliation":
      return await runExistingSpaceOperator(
        {
          surface: invocation.surface,
          action: invocation.action,
          environment: invocation.environment,
          commit: invocation.commit,
        },
        target,
      );
    case "takoserver-org-api-key":
      return await runOrgApiKey(
        {
          surface: invocation.surface,
          action: invocation.action,
          environment: invocation.environment,
          commit: invocation.commit,
          organizationId: invocation.organizationId,
          ...(invocation.keyName === undefined ? {} : { keyName: invocation.keyName }),
          ...(invocation.scopes === undefined ? {} : { scopes: invocation.scopes }),
          ...(invocation.expiresInDays === undefined
            ? {}
            : { expiresInDays: invocation.expiresInDays }),
          ...(invocation.apiKeyId === undefined ? {} : { apiKeyId: invocation.apiKeyId }),
        },
        target,
      );
    case "takoserver-integration-e2e-credentials":
      return await runIntegrationE2eCredentials(
        {
          surface: invocation.surface,
          action: invocation.action,
          environment: invocation.environment,
          commit: invocation.commit,
        },
        target,
      );
    case "takoserver-integration-organization-bootstrap":
      return await runIntegrationOrganizationBootstrap(
        {
          surface: invocation.surface,
          action: invocation.action,
          environment: invocation.environment,
          commit: invocation.commit,
        },
        target,
      );
  }
}

const argv = process.argv.slice(2);
if (argv.length === 1 && argv[0] === "--contract") {
  const contract = `${JSON.stringify(DEPLOY_CONTRACT, null, 2)}\n`;
  await new Promise<void>((resolve, reject) => {
    process.stdout.write(contract, (error?: Error | null) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
  process.exit(0);
}

const invocation = parseInvocation(argv);
if (invocation === null) {
  process.stderr.write(`deploy refused: no target was touched\n\n${USAGE}`);
  process.exit(2);
}

try {
  const result = await dispatch(invocation);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} catch (error) {
  if (!(error instanceof DeployError)) throw error;
  process.stderr.write(`deploy failed during ${error.phase}: ${error.message}\n`);
  if (error.detail) process.stderr.write(`\n${error.detail}\n`);
  process.stderr.write(`\n${deployFailureAftermath(error.phase)}\n`);
  process.exit(PHASE_EXIT_CODE[error.phase]);
}
