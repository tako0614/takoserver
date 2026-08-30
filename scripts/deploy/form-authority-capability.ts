import { YURUCOMMU_IDENTITY_CAPABILITY_KINDS } from "../../src/takoform/implementation-catalog.ts";
import { preflightError } from "./errors.ts";
import type { DeployTarget } from "./target.ts";

/**
 * Proves a target has the provider supplies required by the one code-owned
 * public Form capability manifest. It is a guard only: target values never
 * select or modify P, the capability manifest, or I.
 */
export function assertPublicFormCapabilityTarget(target: DeployTarget): void {
  const actual = target.edgeSupplies?.offerings.map(({ formKind }) => formKind).sort() ?? [];
  const expected = [...YURUCOMMU_IDENTITY_CAPABILITY_KINDS].sort();
  if (actual.length !== expected.length || actual.some((kind, index) => kind !== expected[index])) {
    throw preflightError(
      "Form authority requires the exact four realized Yurucommu identity capabilities",
    );
  }
}
