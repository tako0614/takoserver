import { describe, expect, test } from "bun:test";
import { canonicalJson, type JsonObject } from "../src/json.ts";
import {
  createSelfhostStandardServices,
  SelfhostStandardServiceError,
  type SelfhostStandardServiceIntegration,
  sameSelfhostStandardServiceDeclaration,
} from "../src/providers/selfhost-standard-services.ts";
import type { SelfhostVersionExternalService } from "../src/providers/selfhost-version-bindings.ts";
import type { TakoformStandardServiceProjection } from "../src/takoform/types.ts";

const API_VERSION = "standards.takoform.com/v1" as const;
const SERVICE = { apiVersion: API_VERSION, protocol: "org.example.service" } as const;
const OTHER_SERVICE = { apiVersion: API_VERSION, protocol: "org.example.other" } as const;

function spec(externalServices?: readonly JsonObject[]): JsonObject {
  return externalServices === undefined ? {} : { externalServices };
}

function declaration(
  name: string,
  service: SelfhostStandardServiceIntegration["service"] = SERVICE,
  required?: boolean,
): JsonObject {
  return {
    name,
    ...(required === undefined ? {} : { required }),
    service,
  };
}

function projection(
  name: string,
  service: SelfhostStandardServiceIntegration["service"] = SERVICE,
  required = true,
): TakoformStandardServiceProjection {
  return {
    name,
    service,
    required,
    endpoint: { url: `https://${name.toLowerCase()}.invalid` },
    credential: { key: `${name.toLowerCase()}-key` },
  };
}

function integration(
  service: SelfhostStandardServiceIntegration["service"] = SERVICE,
  serialize: SelfhostStandardServiceIntegration["serialize"] = (value) => ({
    endpoint: value.endpoint.url as string,
    key: value.credential.key as string,
  }),
): SelfhostStandardServiceIntegration {
  return { service, serialize };
}

describe("self-host stable external service materialization", () => {
  test("refuses non-JSON integration output instead of silently converting it", () => {
    for (const value of [new Date(), Promise.resolve({}), { value: undefined }, { value: NaN }]) {
      const services = createSelfhostStandardServices([
        integration(SERVICE, () => value as unknown as JsonObject),
      ]);
      expect(() =>
        services.materialize(spec([declaration("SERVICE")]), [projection("SERVICE")], new Set()),
      ).toThrow(SelfhostStandardServiceError);
    }
  });
  test("matches exact slot identity, sorts slots, defaults required, and canonicalizes JSON", () => {
    const calls: TakoformStandardServiceProjection[] = [];
    const services = createSelfhostStandardServices([
      integration(SERVICE, (value) => {
        calls.push(value);
        return { key: value.credential.key as string, endpoint: value.endpoint.url as string };
      }),
    ]);
    const result = services.materialize(
      spec([declaration("Z_OPTIONAL", OTHER_SERVICE, false), declaration("A_REQUIRED")]),
      [projection("A_REQUIRED")],
      new Set(),
    );

    expect(services.protocols).toEqual([SERVICE]);
    expect(result).toEqual([
      {
        name: "A_REQUIRED",
        required: true,
        service: SERVICE,
        binding: {
          kind: "json",
          value: '{"endpoint":"https://a_required.invalid","key":"a_required-key"}',
        },
      },
      { name: "Z_OPTIONAL", required: false, service: OTHER_SERVICE },
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(projection("A_REQUIRED"));
  });

  test("uses zero defaults without consulting a missing integration or callback", () => {
    let calls = 0;
    const services = createSelfhostStandardServices([
      integration(SERVICE, () => {
        calls += 1;
        return { never: true };
      }),
    ]);

    expect(services.materialize({}, [], new Set())).toEqual([]);
    expect(
      services.materialize(spec([declaration("OPTIONAL", SERVICE, false)]), [], new Set()),
    ).toEqual([{ name: "OPTIONAL", required: false, service: SERVICE }]);
    expect(calls).toBe(0);
  });

  test("rejects a projection whose name, required flag, or protocol is not exact", () => {
    const services = createSelfhostStandardServices([integration()]);
    const declared = spec([declaration("SERVICE")]);
    expect(() => services.materialize(declared, [], new Set())).toThrow(
      SelfhostStandardServiceError,
    );
    for (const candidate of [
      projection("OTHER"),
      projection("SERVICE", SERVICE, false),
      projection("SERVICE", OTHER_SERVICE),
    ]) {
      expect(() => services.materialize(declared, [candidate], new Set())).toThrow(
        SelfhostStandardServiceError,
      );
    }
  });

  test("refuses a runtime namespace collision before invoking a serializer", () => {
    let calls = 0;
    const services = createSelfhostStandardServices([
      integration(SERVICE, () => {
        calls += 1;
        return { key: "unexpected" };
      }),
    ]);

    expect(() =>
      services.materialize(
        spec([declaration("SERVICE")]),
        [projection("SERVICE")],
        new Set(["SERVICE"]),
      ),
    ).toThrow(SelfhostStandardServiceError);
    expect(calls).toBe(0);
  });

  test("sanitizes serializer errors and never exposes callback details", () => {
    const secret = "endpoint=https://private.invalid key=secret-callback-value";
    const services = createSelfhostStandardServices([
      integration(SERVICE, () => {
        throw new Error(secret);
      }),
    ]);

    let thrown: unknown;
    try {
      services.materialize(spec([declaration("SERVICE")]), [projection("SERVICE")], new Set());
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(SelfhostStandardServiceError);
    expect(thrown).toMatchObject({
      message: "the Worker Version external service bindings are unavailable or invalid",
    });
    expect(String((thrown as Error).message)).not.toContain(secret);
  });

  test("compares declaration metadata but ignores retained JSON values", () => {
    const retained: readonly SelfhostVersionExternalService[] = [
      {
        name: "SERVICE",
        required: true,
        service: SERVICE,
        binding: { kind: "json", value: canonicalJson({ key: "retained-secret" }) },
      },
      { name: "OPTIONAL", required: false, service: OTHER_SERVICE },
    ];
    const declared = spec([declaration("OPTIONAL", OTHER_SERVICE, false), declaration("SERVICE")]);
    expect(sameSelfhostStandardServiceDeclaration(declared, retained)).toBe(true);
    expect(
      sameSelfhostStandardServiceDeclaration(
        spec([declaration("SERVICE"), declaration("OTHER", OTHER_SERVICE, false)]),
        retained,
      ),
    ).toBe(false);
    expect(
      sameSelfhostStandardServiceDeclaration(spec([declaration("SERVICE")]), [
        { name: "SERVICE", required: true, service: SERVICE },
      ]),
    ).toBe(false);
  });
});
