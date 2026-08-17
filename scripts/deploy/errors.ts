/**
 * Deploy failures are classified by whether the Cloudflare target could already
 * have been mutated when the failure was raised. The entrypoint maps each phase
 * to a distinct exit code so an operator never has to guess.
 */
export type DeployPhase = "preflight" | "mutation" | "verification";

export const PHASE_EXIT_CODE: Readonly<Record<DeployPhase, number>> = {
  preflight: 2,
  mutation: 3,
  verification: 4,
};

export class DeployError extends Error {
  constructor(
    readonly phase: DeployPhase,
    message: string,
    readonly detail?: string,
  ) {
    super(message);
    this.name = "DeployError";
  }
}

export function preflightError(message: string, detail?: string): DeployError {
  return detail === undefined
    ? new DeployError("preflight", message)
    : new DeployError("preflight", message, detail);
}

export function mutationError(message: string, detail?: string): DeployError {
  return detail === undefined
    ? new DeployError("mutation", message)
    : new DeployError("mutation", message, detail);
}

export function verificationError(message: string, detail?: string): DeployError {
  return detail === undefined
    ? new DeployError("verification", message)
    : new DeployError("verification", message, detail);
}
