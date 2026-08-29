import { runConsole } from "./deploy/console.ts";
import { DEPLOY_CONTRACT } from "./deploy/contract.ts";
import { DeployError, PHASE_EXIT_CODE } from "./deploy/errors.ts";
import { runFormAuthority } from "./deploy/form-authority.ts";
import { runFormAuthorityInvoke } from "./deploy/form-authority-invoke.ts";
import { runHosted } from "./deploy/hosted.ts";
import { runOperatorIdentity } from "./deploy/identity.ts";
import type { DeployEnvironment } from "./deploy/qualification.ts";
import { runRetirement } from "./deploy/retirement.ts";
import { runD1Schema } from "./deploy/schema.ts";
import { runSigning } from "./deploy/signing.ts";
import { runStaticSite } from "./deploy/static.ts";
import { loadTarget, targetPath } from "./deploy/target.ts";
import { isWorkerVersionId, runWorker } from "./deploy/worker.ts";

const USAGE = `takoserver deploy

  bun run deploy -- --contract
  bun run deploy -- <surface> --status --environment=<integration|rehearsal|production> --commit=<sha>
  bun run deploy -- <surface> --apply  --environment=<integration|rehearsal|production> --commit=<sha>
  The authority cutover may add --legacy-predecessor-version=<uuid> for integration bootstrap.
  Hosted-edge authority transition requires the named
  --legacy-host-runtime-predecessor-version=<uuid> selector in integration or production.
  Hosted-edge retirement uses --legacy-host-runtime-predecessor-version=<uuid> and --reverse.

The target descriptor is selected only by the exact environment. There is no
deploy-plan flag, ledger, target override or mixed mutation controller.
`;

type Surface = (typeof DEPLOY_CONTRACT.surfaces)[number]["surface"];

interface Invocation {
  readonly surface: Surface;
  readonly action: "status" | "apply";
  readonly environment: DeployEnvironment;
  readonly commit: string;
  readonly legacyPredecessorVersionId?: string;
  readonly legacyHostRuntimePredecessorVersionId?: string;
  readonly reverse?: boolean;
}

function parseInvocation(args: readonly string[]): Invocation | null {
  if (args.length < 4 || args.length > 6) return null;
  const [surfaceValue, ...flags] = args;
  if (!isSurface(surfaceValue)) return null;
  let action: Invocation["action"] | null = null;
  let environment: DeployEnvironment | null = null;
  let commit: string | null = null;
  let legacyPredecessorVersionId: string | null = null;
  let legacyHostRuntimePredecessorVersionId: string | null = null;
  let reverse = false;
  for (const flag of flags) {
    if (flag === "--status" || flag === "--apply") {
      if (action !== null) return null;
      action = flag.slice(2) as Invocation["action"];
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
      if (legacyPredecessorVersionId !== null || legacyHostRuntimePredecessorVersionId !== null)
        return null;
      const value = flag.slice("--legacy-predecessor-version=".length);
      if (!isWorkerVersionId(value)) return null;
      legacyPredecessorVersionId = value;
      continue;
    }
    if (flag.startsWith("--legacy-host-runtime-predecessor-version=")) {
      if (legacyHostRuntimePredecessorVersionId !== null || legacyPredecessorVersionId !== null)
        return null;
      const value = flag.slice("--legacy-host-runtime-predecessor-version=".length);
      if (!isWorkerVersionId(value)) return null;
      legacyHostRuntimePredecessorVersionId = value;
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
    (surfaceValue === "takoserver-integration-operator-identity" ||
      surfaceValue === "takoserver-integration-form-authority-worker" ||
      surfaceValue === "takoserver-integration-form-authority-operator-worker" ||
      surfaceValue === "takoserver-integration-form-authority") &&
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
      surfaceValue === "takoserver-hosted-token-retirement"
    ) ||
      (environment !== "integration" && environment !== "production"))
  ) {
    return null;
  }
  if (
    legacyHostRuntimePredecessorVersionId === null &&
    (surfaceValue === "takoserver-host-runtime-topology-retirement" ||
      surfaceValue === "takoserver-hosted-token-retirement")
  ) {
    return null;
  }
  if (
    reverse &&
    !(
      surfaceValue === "takoserver-worker-authority-cutover" ||
      surfaceValue === "takoserver-host-runtime-topology-retirement" ||
      surfaceValue === "takoserver-hosted-token-retirement"
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
    ...(reverse ? { reverse: true } : {}),
  };
}

function isSurface(value: string | undefined): value is Surface {
  return DEPLOY_CONTRACT.surfaces.some(({ surface }) => surface === value);
}

async function dispatch(invocation: Invocation): Promise<Record<string, unknown>> {
  const target = loadTarget(targetPath(invocation.environment), invocation.environment);
  switch (invocation.surface) {
    case "takoserver-worker":
    case "takoserver-worker-authority-cutover":
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
          ...(invocation.reverse ? { reverse: true } : {}),
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
    case "takoserver-form-authority-worker":
    case "takoserver-integration-form-authority-worker":
    case "takoserver-integration-form-authority-operator-worker":
      return await runFormAuthority(
        {
          surface: invocation.surface,
          action: invocation.action,
          environment: invocation.environment,
          commit: invocation.commit,
        },
        target,
      );
    case "takoserver-integration-form-authority":
      return await runFormAuthorityInvoke(
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
  const aftermath =
    error.phase === "preflight"
      ? "No target was touched. Fix the cause and re-run the exact surface."
      : error.phase === "mutation"
        ? "The target may have changed. Do not retry; run this surface with --status for authoritative readback."
        : "The mutation was acknowledged but its post-conditions failed. Inspect --status and repair or roll back explicitly.";
  process.stderr.write(`\n${aftermath}\n`);
  process.exit(PHASE_EXIT_CODE[error.phase]);
}
