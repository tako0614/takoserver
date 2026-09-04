import { isAbsolute } from "node:path";
import { API_KEY_SCOPES, type ApiKeyScope } from "../src/auth.ts";
import { runConsole } from "./deploy/console.ts";
import { DEPLOY_CONTRACT } from "./deploy/contract.ts";
import { DeployError, deployFailureAftermath, PHASE_EXIT_CODE } from "./deploy/errors.ts";
import { runFormAuthority } from "./deploy/form-authority.ts";
import { runFormAuthorityIdentityProbe } from "./deploy/form-authority-identity-probe.ts";
import { runFormAuthorityInvoke } from "./deploy/form-authority-invoke.ts";
import { loadFormAuthorityScopeTransition } from "./deploy/form-authority-scope-transition.ts";
import { runHosted } from "./deploy/hosted.ts";
import { runOperatorIdentity } from "./deploy/identity.ts";
import { runIntegrationE2eCredentials } from "./deploy/integration-e2e-credentials.ts";
import { runManagedWorkerGateway } from "./deploy/managed-worker-gateway.ts";
import { runOrgApiKey } from "./deploy/org-api-key.ts";
import type { DeployEnvironment } from "./deploy/qualification.ts";
import { runRetirement } from "./deploy/retirement.ts";
import {
  runD1Schema,
  runD1SchemaRehearsalBaseline,
  SCHEMA_WAVE_BOUNDARIES,
  type SchemaWaveBoundary,
} from "./deploy/schema.ts";
import { runSigning } from "./deploy/signing.ts";
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
  bun run deploy -- takoserver-org-api-key --<mint|status|revoke> --environment=<env> --commit=<sha>
    --organization=org_... [--key-name=<name> --scope=<scope> --expires-in-days=<n>] [--key-id=key_...]
  Rehearsal and production D1 schema status/apply require one fixed next-wave selector:
    --through-migration=<0028|0033|0036|0043>
  Pending 0043 additionally requires the staged pre-0043-quiesced Worker target and the absolute
  operator-private TAKOSERVER_ARTIFACT_BLOB_IO_QUIESCENCE_RECEIPT_PATH documented in docs/deploy.md.
  takoserver-d1-schema-rehearsal-baseline is fixed empty -> 0022, rehearsal-only, and accepts no selector.
  The authority cutover may add --legacy-predecessor-version=<uuid> for integration bootstrap.
  Hosted-edge authority transition requires the named
  --legacy-host-runtime-predecessor-version=<uuid> selector in integration or production.
  Every Worker-publishing surface accepts the same reviewed forward transition:
  --closure-predecessor-version=<uuid> with an explicit delta of repeatable
  --retire-var=NAME, --add-var=NAME, --refresh-var=NAME, --add-binding=NAME, --add-secret=NAME
  and --rotate-secret=NAME. --refresh-var publishes a changed value of a var both sides already
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

The target descriptor is selected only by the exact environment. There is no
deploy-plan flag, ledger, target override or mixed mutation controller.
`;

type Surface = (typeof DEPLOY_CONTRACT.surfaces)[number]["surface"];
type CredentialSurface = "takoserver-integration-e2e-credentials";
type OrgApiKeySurface = "takoserver-org-api-key";
type StandardSurface = Exclude<Surface, CredentialSurface | OrgApiKeySurface>;

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
  readonly reverse?: boolean;
}

type Invocation =
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
  readonly throughMigration?: SchemaWaveBoundary;
  readonly organizationId?: string;
  readonly keyName?: string;
  readonly scopes?: readonly ApiKeyScope[];
  readonly expiresInDays?: number;
  readonly apiKeyId?: string;
  readonly reverse?: boolean;
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

function parseInvocation(args: readonly string[]): Invocation | null {
  if (args.length < 4 || args.length > 7 + Math.max(MAX_CLOSURE_DELTA_FLAGS, MAX_ORG_API_KEY_FLAGS))
    return null;
  const [surfaceValue, ...flags] = args;
  if (!isSurface(surfaceValue)) return null;
  let action: ParsedInvocation["action"] | null = null;
  let environment: DeployEnvironment | null = null;
  let commit: string | null = null;
  let legacyPredecessorVersionId: string | null = null;
  let legacyHostRuntimePredecessorVersionId: string | null = null;
  let closurePredecessorVersionId: string | null = null;
  const retireVars: string[] = [];
  const addVars: string[] = [];
  const refreshVars: string[] = [];
  const addBindings: string[] = [];
  const addSecrets: string[] = [];
  const rotateSecrets: string[] = [];
  let unattributedSuccessorVersionId: string | null = null;
  let formAuthorityScopeTransitionPath: string | null = null;
  let adoptLivePath: string | null = null;
  let bootstrapVerifierBridge = false;
  let bootstrapProbePredecessorVersionId: string | null = null;
  let throughMigration: SchemaWaveBoundary | null = null;
  let organizationId: string | null = null;
  let keyName: string | null = null;
  const scopes: ApiKeyScope[] = [];
  let expiresInDays: number | null = null;
  let apiKeyId: string | null = null;
  let reverse = false;
  for (const flag of flags) {
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
    if (flag.startsWith("--commit=")) {
      if (commit !== null) return null;
      const value = flag.slice("--commit=".length);
      if (!/^[0-9a-f]{40}$/u.test(value)) return null;
      commit = value;
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
      if (!SCHEMA_WAVE_BOUNDARIES.includes(value as SchemaWaveBoundary)) return null;
      throughMigration = value as SchemaWaveBoundary;
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
  const closureDeltaNames = [
    ...retireVars,
    ...addVars,
    ...refreshVars,
    ...addBindings,
    ...addSecrets,
    ...rotateSecrets,
  ];
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
  const budget = 6 + (adoptLivePath === null ? 0 : 1) + (bootstrapVerifierBridge ? 1 : 0);
  if (closurePredecessorVersionId === null) {
    // Every other invocation keeps the historical exact flag budget.
    if (args.length > budget || closureDeltaNames.length > 0) return null;
  } else if (
    !TRANSITION_SURFACES.includes(surfaceValue) ||
    reverse ||
    closureDeltaNames.length === 0 ||
    closureDeltaNames.length > MAX_CLOSURE_DELTA_FLAGS ||
    args.length > budget + MAX_CLOSURE_DELTA_FLAGS ||
    new Set(closureDeltaNames).size !== closureDeltaNames.length
  ) {
    return null;
  }
  // The candidate descriptor is a readback product; it never accompanies a
  // mutation, so the surface can never be asked to adopt and publish at once.
  if (
    surfaceValue === "takoserver-d1-schema-rehearsal-baseline" &&
    (environment !== "rehearsal" || throughMigration !== null)
  ) {
    return null;
  }
  if (
    surfaceValue === "takoserver-d1-schema" &&
    ((environment === "integration" && throughMigration !== null) ||
      (environment !== "integration" && throughMigration === null))
  ) {
    return null;
  }
  if (
    surfaceValue !== "takoserver-d1-schema" &&
    surfaceValue !== "takoserver-d1-schema-rehearsal-baseline" &&
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
      surfaceValue === "takoserver-worker-authority-cutover" ||
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
    (surfaceValue === "takoserver-host-runtime-topology-retirement" ||
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
      surfaceValue === "takoserver-worker-authority-cutover" ||
      surfaceValue === "takoserver-host-runtime-topology-retirement" ||
      surfaceValue === "takoserver-managed-worker-gateway"
    )
  ) {
    return null;
  }
  if (reverse && action !== "apply") return null;
  if (
    reverse &&
    surfaceValue === "takoserver-worker-authority-cutover" &&
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
            addedBindings: [...addBindings].sort(),
            addedSecrets: [...addSecrets].sort(),
            rotatedSecrets: [...rotateSecrets].sort(),
          },
        }),
    ...(unattributedSuccessorVersionId === null ? {} : { unattributedSuccessorVersionId }),
    ...(formAuthorityScopeTransitionPath === null ? {} : { formAuthorityScopeTransitionPath }),
    ...(adoptLivePath === null ? {} : { adoptLivePath }),
    ...(bootstrapVerifierBridge ? { bootstrapVerifierBridge: true } : {}),
    ...(bootstrapProbePredecessorVersionId === null ? {} : { bootstrapProbePredecessorVersionId }),
    ...(throughMigration === null ? {} : { throughMigration }),
    ...(reverse ? { reverse: true } : {}),
  } as Invocation;
}

type ClosureDeltaFlagKind =
  | "retire-var"
  | "add-var"
  | "refresh-var"
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

async function dispatch(invocation: Invocation): Promise<Record<string, unknown>> {
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
      if (
        invocation.surface === "takoserver-worker-authority-cutover" &&
        invocation.legacyHostRuntimePredecessorVersionId !== undefined
      ) {
        return await runRetirement(
          {
            surface: invocation.surface,
            action: invocation.action,
            environment: invocation.environment,
            commit: invocation.commit,
            ...(invocation.reverse ? { reverse: true } : {}),
            legacyHostRuntimePredecessorVersionId: invocation.legacyHostRuntimePredecessorVersionId,
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
    case "takoserver-d1-schema":
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
      );
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
    case "takoserver-hosted-token-cutover":
      return await runHosted(
        {
          surface: invocation.surface,
          action: invocation.action,
          environment: invocation.environment,
          commit: invocation.commit,
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
    case "takoserver-managed-worker-gateway":
      return await runManagedWorkerGateway(
        {
          surface: invocation.surface,
          action: invocation.action,
          environment: invocation.environment,
          commit: invocation.commit,
          ...(invocation.reverse ? { reverse: true } : {}),
        },
        target,
      );
    case "takoserver-form-authority-worker":
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
  }
}

const argv = process.argv.slice(2);
if (argv.length === 1 && argv[0] === "--contract") {
  process.stdout.write(`${JSON.stringify(DEPLOY_CONTRACT, null, 2)}\n`);
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
