import { describe, expect, test } from "bun:test";
import {
  assertReleasedTakoformProviderForms,
  releasedTakoformProviderForms,
} from "../src/takoform/released-provider-catalog.ts";
import type { InstalledTakoformForm } from "../src/takoform/types.ts";

describe("released Takoform provider catalog", () => {
  test("derives the shipped Form from the pinned provider release", () => {
    const forms = releasedTakoformProviderForms();

    expect(forms.map((form) => form.identity)).toEqual([
      {
        formRef: {
          apiVersion: "edge.forms.takoform.com/v1beta1",
          kind: "ObjectBucket",
          definitionVersion: "0.1.0",
          schemaDigest: "sha256:3383a60c12bdc5a853868bd7ccab3670e1aff7b3eca889583b86d11ac0f90494",
        },
        packageDigest: "sha256:553675391d888c6fd4e336cb9f05bf6a988a14f743327f6ff968914326ea8a21",
      },
    ]);
  });

  test("refuses a Takoserver-authored Form even inside the Takoform namespace", () => {
    const official = releasedTakoformProviderForms()[0];
    const mystery = {
      ...structuredClone(official),
      identity: {
        formRef: {
          ...official.identity.formRef,
          kind: "TakoserverMysteryService",
          schemaDigest: `sha256:${"f".repeat(64)}`,
        },
        packageDigest: `sha256:${"e".repeat(64)}`,
      },
      displayName: "Mystery service",
    } satisfies InstalledTakoformForm;

    expect(() => assertReleasedTakoformProviderForms([official, mystery])).toThrow(
      "unreleased_takoform_form",
    );
  });

  test("refuses a local definition hidden behind an official identity", () => {
    const official = releasedTakoformProviderForms()[0];
    const drifted = {
      ...structuredClone(official),
      description: "A local Takoserver definition pretending to be the released Form.",
    } satisfies InstalledTakoformForm;

    expect(() => assertReleasedTakoformProviderForms([drifted])).toThrow(
      "released_takoform_definition_mismatch",
    );
  });
});
