import { preflightError } from "./errors.ts";
import type { FormAuthoritySurface } from "./form-authority.ts";
import type { DeployProcess } from "./process.ts";

type FormCodeSurface = FormAuthoritySurface | "takoserver-form-authority-identity-probe";

const COMMON_TESTS = [
  "tests/deploy-worker-artifact.test.ts",
  "tests/deploy-worker-state.test.ts",
  "tests/deploy-contract.test.ts",
  "tests/takoform-static-authority-boundary.test.ts",
  "tests/takoform-public-worker-implementation.test.ts",
];

const SURFACE_TESTS: Record<FormCodeSurface, readonly string[]> = {
  "takoserver-form-authority-identity-probe": [
    "tests/form-authority-identity-probe.test.ts",
    "tests/form-authority-verifier-readback.test.ts",
    "tests/deploy-form-authority-identity-probe.test.ts",
    "tests/deploy-form-authority-bootstrap-sequence.test.ts",
  ],
  "takoserver-form-authority-worker": [
    "tests/deploy-form-authority.test.ts",
    "tests/deploy-form-authority-bootstrap-sequence.test.ts",
    "tests/form-authority-verifier-readback.test.ts",
    "tests/takoform-core-verifier-adapter.test.ts",
    "tests/takoform-publisher-set-import.test.ts",
    "tests/takoform-operator-authority.test.ts",
    "tests/takoform-implementation-catalog.test.ts",
  ],
  "takoserver-integration-form-authority-worker": [
    "tests/deploy-form-authority.test.ts",
    "tests/takoform-integration-operator-endpoint.test.ts",
    "tests/takoform-publisher-set-import.test.ts",
    "tests/takoform-operator-authority.test.ts",
    "tests/takoform-implementation-catalog.test.ts",
  ],
  "takoserver-integration-form-authority-operator-worker": [
    "tests/deploy-form-authority.test.ts",
    "tests/integration-form-authority-gateway.test.ts",
    "tests/takoform-integration-operator-endpoint.test.ts",
    "tests/deploy-form-authority-invoke.test.ts",
    "tests/deploy-form-authority-scope-transition.test.ts",
  ],
};

/**
 * Form-local checks for an already-qualified ordinary integration code update.
 * Callers still own environment/closure/schema eligibility and publication
 * fences. This runs once per owner invocation; it neither caches nor attests.
 */
export async function runFormAuthorityCodeGate(
  run: DeployProcess,
  surface: FormCodeSurface,
): Promise<void> {
  const commands: readonly (readonly string[])[] = [
    ...[
      "typecheck",
      "typecheck:form-authority-worker",
      "check:form-authority-worker-types",
      "check:imports",
      "check:form-corpora",
      "check:integration-form-packages",
    ].map((script) => ["bun", "run", script]),
    ["bun", "test", ...COMMON_TESTS, ...SURFACE_TESTS[surface]],
    // The owning build checks all four entrypoints and binding closures, with
    // containers-rollout=none. It does not build or publish a Container image.
    ["bun", "run", "build:form-authority-worker"],
  ];
  for (const command of commands) {
    const result = await run(command);
    if (result.exitCode !== 0) {
      throw preflightError(
        `Form code gate ${command.join(" ")} failed (exit ${result.exitCode})`,
        `${result.stdout}${result.stderr}`.trim(),
      );
    }
  }
}
