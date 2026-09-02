import { isAbsolute } from "node:path";
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
import type { DeployEnvironment } from "./deploy/qualification.ts";
import { runRetirement } from "./deploy/retirement.ts";
import { runD1Schema } from "./deploy/schema.ts";
import { runSigning } from "./deploy/signing.ts";
import { runStaticSite } from "./deploy/static.ts";
import { loadTarget, targetPath } from "./deploy/target.ts";
import { isWorkerVersionId, runWorker } from "./deploy/worker.ts";
import { runWorkerClosureTransition } from "./deploy/worker-closure-transition.ts";
import type { WorkerClosureDelta } from "./deploy/worker-state.ts";

const USAGE = `takoserver deploy

  bun run deploy -- --contract
  bun run deploy -- <surface> --status --environment=<integration|rehearsal|production> --commit=<sha>
  bun run deploy -- <surface> --apply  --environment=<integration|rehearsal|production> --commit=<sha>
  bun run deploy -- takoserver-integration-e2e-credentials --<issue|status|revoke> --environment=integration --commit=<sha>
  The authority cutover may add --legacy-predecessor-version=<uuid> for integration bootstrap.
  Hosted-edge authority transition requires the named
  --legacy-host-runtime-predecessor-version=<uuid> selector in integration or production.
  The reviewed closure transition uses --closure-predecessor-version=<uuid> with an explicit
  delta of repeatable --retire-var=NAME, --add-var=NAME, --refresh-var=NAME, --add-secret=NAME and
  --rotate-secret=NAME; --refresh-var publishes a changed value of a var both sides already declare,
  and added and rotated secret values come only from TAKOSERVER_WORKER_CLOSURE_SECRET_DIRECTORY.
  Hosted-edge authority/topology retirement uses --legacy-host-runtime-predecessor-version=<uuid>
  and --reverse; token retirement is forward-only.
  Post-token attribution repair uses both --legacy-host-runtime-predecessor-version=<uuid>
  and --unattributed-successor-version=<uuid>; it has no --reverse mode.
  Integration Form-authority scope retirement uses the operator-private
  --form-authority-scope-transition=/absolute/file.json selector only on deactivation,
  the route-less authority Worker and its operator gateway.

The target descriptor is selected only by the exact environment. There is no
deploy-plan flag, ledger, target override or mixed mutation controller.
`;

type Surface = (typeof DEPLOY_CONTRACT.surfaces)[number]["surface"];
type CredentialSurface = "takoserver-integration-e2e-credentials";
type StandardSurface = Exclude<Surface, CredentialSurface>;

interface InvocationBase {
  readonly environment: DeployEnvironment;
  readonly commit: string;
  readonly legacyPredecessorVersionId?: string;
  readonly legacyHostRuntimePredecessorVersionId?: string;
  readonly closurePredecessorVersionId?: string;
  readonly closureDelta?: WorkerClosureDelta;
  readonly unattributedSuccessorVersionId?: string;
  readonly formAuthorityScopeTransitionPath?: string;
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
    });

interface ParsedInvocation {
  readonly surface: Surface;
  readonly action: "status" | "apply" | "issue" | "revoke";
  readonly environment: DeployEnvironment;
  readonly commit: string;
  readonly legacyPredecessorVersionId?: string;
  readonly legacyHostRuntimePredecessorVersionId?: string;
  readonly closurePredecessorVersionId?: string;
  readonly closureDelta?: WorkerClosureDelta;
  readonly unattributedSuccessorVersionId?: string;
  readonly formAuthorityScopeTransitionPath?: string;
  readonly reverse?: boolean;
}

/**
 * The closure transition is the only selector with repeatable operands. Its
 * declaration stays bounded so an invocation can never grow into an unreviewed
 * bulk rewrite of the realized closure.
 */
const MAX_CLOSURE_DELTA_FLAGS = 32;
const CLOSURE_DELTA_NAME = /^[A-Z][A-Z0-9_]{0,63}$/u;

function parseInvocation(args: readonly string[]): Invocation | null {
  if (args.length < 4 || args.length > 6 + MAX_CLOSURE_DELTA_FLAGS) return null;
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
  const addSecrets: string[] = [];
  const rotateSecrets: string[] = [];
  let unattributedSuccessorVersionId: string | null = null;
  let formAuthorityScopeTransitionPath: string | null = null;
  let reverse = false;
  for (const flag of flags) {
    if (flag === "--status" || flag === "--apply" || flag === "--issue" || flag === "--revoke") {
      if (action !== null) return null;
      action = flag.slice(2) as ParsedInvocation["action"];
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
    ...addSecrets,
    ...rotateSecrets,
  ];
  if (closurePredecessorVersionId === null) {
    // Every other invocation keeps the historical exact flag budget.
    if (args.length > 6 || closureDeltaNames.length > 0) return null;
  } else if (
    surfaceValue !== "takoserver-worker-authority-cutover" ||
    reverse ||
    closureDeltaNames.length === 0 ||
    closureDeltaNames.length > MAX_CLOSURE_DELTA_FLAGS ||
    new Set(closureDeltaNames).size !== closureDeltaNames.length
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
    (surfaceValue === "takoserver-integration-operator-identity" ||
      surfaceValue === "takoserver-integration-form-authority-worker" ||
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
            addedSecrets: [...addSecrets].sort(),
            rotatedSecrets: [...rotateSecrets].sort(),
          },
        }),
    ...(unattributedSuccessorVersionId === null ? {} : { unattributedSuccessorVersionId }),
    ...(formAuthorityScopeTransitionPath === null ? {} : { formAuthorityScopeTransitionPath }),
    ...(reverse ? { reverse: true } : {}),
  } as Invocation;
}

type ClosureDeltaFlagKind =
  | "retire-var"
  | "add-var"
  | "refresh-var"
  | "add-secret"
  | "rotate-secret";

function closureDeltaFlag(
  flag: string,
): { readonly kind: ClosureDeltaFlagKind; readonly name: string } | null {
  for (const kind of [
    "retire-var",
    "add-var",
    "refresh-var",
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
    case "takoserver-d1-schema":
      return await runD1Schema(invocation, target);
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
    case "takoserver-integration-operator-identity":
      return await runOperatorIdentity(
        {
          surface: invocation.surface,
          action: invocation.action,
          environment: invocation.environment,
          commit: invocation.commit,
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
