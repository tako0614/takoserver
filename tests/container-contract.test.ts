import { expect, test } from "bun:test";
import { CONTAINER_CONTRACT as C } from "../src/container-contract.ts";
import { parseContainerSpec, parseContainerSpecJson } from "../src/takoform-v2/forms/container.ts";

const F = C.fields;
const spec = () => ({
  [F.image]: `registry.example/app@sha256:${"a".repeat(64)}`,
  [F.httpPort]: 8080,
  [F.healthPath]: "/health",
  [F.workloadRevision]: "v1",
});

test("closed Container profile expands defaults without normalizing strings", () => {
  expect(parseContainerSpec(spec())).toEqual({
    ...spec(),
    [F.environment]: {},
    [F.requiredSensitiveVars]: [],
    [F.outboundInternet]: false,
  });
  expect(
    parseContainerSpec({ ...spec(), [F.environment]: { _MODE: " value " } })[F.environment],
  ).toEqual({ _MODE: " value " });
});

for (const [field, values] of [
  [
    F.image,
    [
      "app@sha256:" + "a".repeat(64),
      "registry.example/app:latest",
      "https://registry.example/app@sha256:" + "a".repeat(64),
      "user@registry.example/app@sha256:" + "a".repeat(64),
      "registry.example/app@sha256:" + "A".repeat(64),
    ],
  ],
  [F.httpPort, [0, 65536, 1.5, "8080", null]],
  [
    F.healthPath,
    [
      "health",
      "//authority",
      "/a?x",
      "/a#x",
      "/a\\b",
      "/a/../b",
      "/a/%2e%2e/b",
      "/a%2fb",
      "/a%5cb",
      "/a%00b",
      "/a%252fb",
      "/a%",
      "/a b",
    ],
  ],
  [F.workloadRevision, ["", ".v1", "a".repeat(129), null]],
  [
    F.environment,
    [
      null,
      { "APP.MODE": "x" },
      { CLOUDFLARE_X: "x" },
      { TAKOFORM_X: "x" },
      { APP: "a\0b" },
      { APP: "a".repeat(4097) },
    ],
  ],
  [F.requiredSensitiveVars, [null, ["TOKEN"]]],
  [F.outboundInternet, [null, true, "false"]],
] as const) {
  for (const value of values)
    test(`reject invalid ${field} ${JSON.stringify(value).slice(0, 100)}`, () => {
      expect(() => parseContainerSpec({ ...spec(), [field]: value })).toThrow();
    });
}

test("reject unknown, duplicate and null fields and private inputs before execution", () => {
  expect(() => parseContainerSpec({ ...spec(), size: 1 })).toThrow();
  expect(() => parseContainerSpec(spec(), { TOKEN: "secret" })).toThrow();
  expect(() => parseContainerSpec(spec(), null)).toThrow();
  expect(() =>
    parseContainerSpecJson(
      new TextEncoder().encode(
        JSON.stringify(spec()).replace("8080", '8080,"' + F.httpPort + '":8081'),
      ),
    ),
  ).toThrow();
  expect(parseContainerSpec(spec(), {})).toBeDefined();
});
