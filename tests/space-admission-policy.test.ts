import { describe, expect, test } from "bun:test";
import { canonicalJson } from "../src/json.ts";
import {
  parseSpaceAdmissionPolicy,
  type SpaceAdmissionPolicyV1,
  type SpaceAdmissionPolicyValidationBounds,
  spaceAdmissionPolicyDigest,
  validateSpaceAdmissionPolicy,
} from "../src/takoform/space-admission-policy.ts";

const digest = (character: string): `sha256:${string}` => `sha256:${character.repeat(64)}`;

const formA = {
  apiVersion: "edge.forms.takoform.com",
  kind: "Alpha",
  definitionVersion: "1.0.0",
  schemaDigest: digest("a"),
} as const;
const formB = {
  apiVersion: "edge.forms.takoform.com",
  kind: "Beta",
  definitionVersion: "1.0.0",
  schemaDigest: digest("b"),
} as const;
const formC = {
  apiVersion: "edge.forms.takoform.com",
  kind: "Gamma",
  definitionVersion: "1.0.0",
  schemaDigest: digest("c"),
} as const;
const formUnknown = {
  apiVersion: "edge.forms.takoform.com",
  kind: "Unknown",
  definitionVersion: "1.0.0",
  schemaDigest: digest("d"),
} as const;

const packageA = digest("1");
const packageB = digest("2");
const packageC = digest("3");

const policy = (
  forms: readonly SpaceAdmissionPolicyV1["forms"][number][],
): SpaceAdmissionPolicyV1 => ({
  kind: "takoserver.space-form-admission-policy@v1",
  organizationId: "org-example",
  forms,
});

const bounds: SpaceAdmissionPolicyValidationBounds = {
  publisherPackageSet: [
    { formRef: formA, packageDigest: packageA },
    { formRef: formB, packageDigest: packageB },
    { formRef: formC, packageDigest: packageC },
  ],
  implementationCatalog: {
    kind: "takoserver.form-implementation-catalog@v1",
    capabilityDigest: digest("4"),
    implementationDigest: digest("5"),
    entries: [
      { formRef: formA, packageDigest: packageA, operations: ["create"] },
      { formRef: formB, packageDigest: packageB, operations: ["read"] },
    ],
  },
};

describe("space form admission policy", () => {
  test("parses the exact object shape and canonicalizes form order", () => {
    const parsed = parseSpaceAdmissionPolicy(
      policy([
        { formRef: formB, packageDigest: packageB },
        { formRef: formA, packageDigest: packageA },
      ]),
    );

    expect(parsed.forms).toEqual([
      { formRef: formA, packageDigest: packageA },
      { formRef: formB, packageDigest: packageB },
    ]);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.forms)).toBe(true);
    expect(Object.isFrozen(parsed.forms[0])).toBe(true);
    expect(Object.isFrozen(parsed.forms[0]?.formRef)).toBe(true);
  });

  test("rejects malformed values and every extra key", () => {
    expect(() => parseSpaceAdmissionPolicy(null)).toThrow();
    expect(() => parseSpaceAdmissionPolicy({})).toThrow();
    expect(() => parseSpaceAdmissionPolicy({ ...policy([]), forms: [] })).toThrow();
    expect(() =>
      parseSpaceAdmissionPolicy({
        ...policy([{ formRef: formA, packageDigest: packageA }]),
        extra: true,
      }),
    ).toThrow();
    expect(() =>
      parseSpaceAdmissionPolicy(
        policy([
          {
            formRef: {
              ...formA,
              extra: true,
            } as unknown as SpaceAdmissionPolicyV1["forms"][number]["formRef"],
            packageDigest: packageA,
          },
        ]),
      ),
    ).toThrow();
    expect(() =>
      parseSpaceAdmissionPolicy(
        policy([{ formRef: formA, packageDigest: "sha256:not-a-digest" as `sha256:${string}` }]),
      ),
    ).toThrow();
    expect(() =>
      parseSpaceAdmissionPolicy({
        ...policy([{ formRef: formA, packageDigest: packageA }]),
        organizationId: "",
      }),
    ).toThrow();
    for (const organizationId of [
      "ab",
      " org-example",
      "org-example\n",
      `org-${"x".repeat(254)}`,
    ]) {
      expect(() =>
        parseSpaceAdmissionPolicy({
          ...policy([{ formRef: formA, packageDigest: packageA }]),
          organizationId,
        }),
      ).toThrow();
    }
  });

  test("rejects duplicate exact Forms and conflicting package identities", () => {
    expect(() =>
      parseSpaceAdmissionPolicy(
        policy([
          { formRef: formA, packageDigest: packageA },
          { formRef: formA, packageDigest: packageA },
        ]),
      ),
    ).toThrow();
    expect(() =>
      parseSpaceAdmissionPolicy(
        policy([
          { formRef: formA, packageDigest: packageA },
          { formRef: formA, packageDigest: packageB },
        ]),
      ),
    ).toThrow();
  });

  test("organization identity fits the coordinator's 255-character bound", () => {
    const input = policy([{ formRef: formA, packageDigest: packageA }]);
    expect(
      parseSpaceAdmissionPolicy({ ...input, organizationId: "a".repeat(255) }).organizationId,
    ).toHaveLength(255);
    expect(() =>
      parseSpaceAdmissionPolicy({ ...input, organizationId: "a".repeat(256) }),
    ).toThrow();
  });

  test("validates against the full publisher package set and realized catalog", async () => {
    const input = policy([
      { formRef: formB, packageDigest: packageB },
      { formRef: formA, packageDigest: packageA },
    ]);
    const publisherBefore = structuredClone(bounds.publisherPackageSet);
    const catalogBefore = structuredClone(bounds.implementationCatalog);
    const result = await validateSpaceAdmissionPolicy(input, bounds);

    expect(result.policy).toEqual(
      policy([
        { formRef: formA, packageDigest: packageA },
        { formRef: formB, packageDigest: packageB },
      ]),
    );
    expect(result.selectedIdentities).toEqual([
      { formRef: formA, packageDigest: packageA },
      { formRef: formB, packageDigest: packageB },
    ]);
    expect(result.digest).toBe(await spaceAdmissionPolicyDigest(result.policy));
    expect(result.canonicalJson).toBe(canonicalJson(result.policy));
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.selectedIdentities)).toBe(true);
    expect(input.forms).toEqual([
      { formRef: formB, packageDigest: packageB },
      { formRef: formA, packageDigest: packageA },
    ]);
    expect(bounds.publisherPackageSet).toEqual(publisherBefore);
    expect(bounds.implementationCatalog).toEqual(catalogBefore);
  });

  test("rejects unknown publisher identities", async () => {
    await expect(
      validateSpaceAdmissionPolicy(
        policy([{ formRef: formUnknown, packageDigest: packageA }]),
        bounds,
      ),
    ).rejects.toThrow(/publisher package set|unknown/i);
  });

  test("rejects a published Form with no realized implementation", async () => {
    await expect(
      validateSpaceAdmissionPolicy(policy([{ formRef: formC, packageDigest: packageC }]), bounds),
    ).rejects.toThrow(/implementation catalog|implemented/i);
  });

  test("rejects package mismatches instead of substituting a package", async () => {
    await expect(
      validateSpaceAdmissionPolicy(policy([{ formRef: formA, packageDigest: packageA }]), {
        ...bounds,
        implementationCatalog: {
          ...bounds.implementationCatalog,
          entries: [
            {
              formRef: formA,
              packageDigest: packageB,
              operations: ["create"],
            },
          ],
        },
      }),
    ).rejects.toThrow(/package/i);
  });

  test("produces the same digest regardless of input order", async () => {
    const first = await validateSpaceAdmissionPolicy(
      policy([
        { formRef: formB, packageDigest: packageB },
        { formRef: formA, packageDigest: packageA },
      ]),
      bounds,
    );
    const second = await validateSpaceAdmissionPolicy(
      policy([
        { formRef: formA, packageDigest: packageA },
        { formRef: formB, packageDigest: packageB },
      ]),
      bounds,
    );

    expect(first.digest).toBe(second.digest);
    expect(first.digest).toBe(
      "sha256:79d739635574481771b29dc8ab1542acd251f9fad3102485e4532c517a442577",
    );
    expect(first.canonicalJson).toBe(second.canonicalJson);
    expect(first.policy).toEqual(second.policy);
  });

  test("accepts canonical JSON input and rejects noncanonical JSON", () => {
    const parsed = parseSpaceAdmissionPolicy(
      canonicalJson(policy([{ formRef: formA, packageDigest: packageA }])),
    );
    expect(parsed).toEqual(policy([{ formRef: formA, packageDigest: packageA }]));
    expect(() =>
      parseSpaceAdmissionPolicy(
        JSON.stringify(policy([{ formRef: formA, packageDigest: packageA }])),
      ),
    ).toThrow(/canonical/i);
  });
});
