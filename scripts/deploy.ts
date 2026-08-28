import { runConsole } from "./deploy/console.ts";
import { DEPLOY_CONTRACT } from "./deploy/contract.ts";
import { DeployError, PHASE_EXIT_CODE } from "./deploy/errors.ts";
import { runHosted } from "./deploy/hosted.ts";
import type { DeployEnvironment } from "./deploy/qualification.ts";
import { runD1Schema } from "./deploy/schema.ts";
import { runSigning } from "./deploy/signing.ts";
import { runStaticSite } from "./deploy/static.ts";
import { loadTarget, targetPath } from "./deploy/target.ts";
import { runWorker } from "./deploy/worker.ts";

const USAGE = `takoserver deploy

  bun run deploy -- --contract
  bun run deploy -- <surface> --status --environment=<integration|rehearsal|production> --commit=<sha>
  bun run deploy -- <surface> --apply  --environment=<integration|rehearsal|production> --commit=<sha>

The target descriptor is selected only by the exact environment. There is no
plan, ledger, target override or mixed mutation controller.
`;

type Surface = (typeof DEPLOY_CONTRACT.surfaces)[number]["surface"];

interface Invocation {
  readonly surface: Surface;
  readonly action: "status" | "apply";
  readonly environment: DeployEnvironment;
  readonly commit: string;
}

function parseInvocation(args: readonly string[]): Invocation | null {
  if (args.length !== 4) return null;
  const [surfaceValue, ...flags] = args;
  if (!isSurface(surfaceValue)) return null;
  let action: Invocation["action"] | null = null;
  let environment: DeployEnvironment | null = null;
  let commit: string | null = null;
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
    return null;
  }
  return action && environment && commit
    ? { surface: surfaceValue, action, environment, commit }
    : null;
}

function isSurface(value: string | undefined): value is Surface {
  return DEPLOY_CONTRACT.surfaces.some(({ surface }) => surface === value);
}

async function dispatch(invocation: Invocation): Promise<Record<string, unknown>> {
  const target = loadTarget(targetPath(invocation.environment), invocation.environment);
  switch (invocation.surface) {
    case "takoserver-worker":
    case "takoserver-worker-authority-cutover":
      return await runWorker(
        {
          surface: invocation.surface,
          action: invocation.action,
          environment: invocation.environment,
          commit: invocation.commit,
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
    case "takoserver-hosted-topology-cutover":
      return await runHosted(
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
