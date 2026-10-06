import { describe, expect, test } from "bun:test";
import {
  parseTakoformV2ApplicationConfig,
  parseTakoformV2PublicConfig,
  V2ApplicationConfigError,
} from "../src/takoform-v2/config.ts";

const CURSOR_KEY = "A".repeat(43);

describe("Takoform v2 application configuration", () => {
  test("pure deploy parser validates the same non-secret JSON without a cursor key", () => {
    const json = JSON.stringify({
      documentation: "https://docs.example.invalid/takoform-v2",
      authenticationDocumentation: "https://docs.example.invalid/authentication",
      staticAssetBundle: { targetKey: "asset-target", heldArtifacts: [] },
    });
    const publicConfig = parseTakoformV2PublicConfig(json);
    expect(publicConfig.staticAssetBundle).toEqual({
      targetKey: "asset-target",
      heldArtifacts: [],
    });
    expect(publicConfig).not.toHaveProperty("cursorSigningKey");
    expect(() => parseTakoformV2PublicConfig(`${json.slice(0, -1)},"extra":1}`)).toThrow(
      "invalid_configuration",
    );
    // Startup still requires the separately managed key, even for valid JSON.
    expect(() => parseTakoformV2ApplicationConfig({ TAKOSERVER_TAKOFORM_V2_CONFIG: json })).toThrow(
      "missing_cursor_key",
    );
  });
  test("parses required HTTPS documentation and decodes the separate cursor key", () => {
    const config = parseTakoformV2ApplicationConfig({
      TAKOSERVER_TAKOFORM_V2_CONFIG: JSON.stringify({
        documentation: "https://docs.example.invalid/takoform-v2",
        authenticationDocumentation: "https://docs.example.invalid/authentication",
      }),
      TAKOSERVER_TAKOFORM_V2_CURSOR_KEY: CURSOR_KEY,
    });

    expect(config.documentation).toBe("https://docs.example.invalid/takoform-v2");
    expect(config.authenticationDocumentation).toBe("https://docs.example.invalid/authentication");
    expect(config.cursorSigningKey).toEqual(new Uint8Array(32));
    expect(config.sqliteMigrationSet).toBeUndefined();
    expect(config.workerBundle).toBeUndefined();
    expect(config.staticAssetBundle).toBeUndefined();
  });

  test("preserves only explicitly configured migration target, sources, and grants", () => {
    const heldArtifact = {
      url: "https://Artifacts.example.invalid/manifest.json",
      sha256: "1".repeat(64),
      objectKey: "operator-held/migration-manifest",
      grants: [{ principal: "org:org-a", space: "org-a" }],
    };
    const config = parseTakoformV2ApplicationConfig({
      TAKOSERVER_TAKOFORM_V2_CONFIG: JSON.stringify({
        documentation: "https://docs.example.invalid/takoform-v2",
        authenticationDocumentation: "https://docs.example.invalid/authentication",
        sqliteMigrationSet: {
          targetKey: "operator-sqlite-primary",
          heldArtifacts: [heldArtifact],
        },
      }),
      TAKOSERVER_TAKOFORM_V2_CURSOR_KEY: CURSOR_KEY,
    });

    expect(config.sqliteMigrationSet).toEqual({
      targetKey: "operator-sqlite-primary",
      heldArtifacts: [heldArtifact],
    });
  });

  test("allows an explicitly configured deny-all source but does not synthesize a Form", () => {
    const config = parseTakoformV2ApplicationConfig({
      TAKOSERVER_TAKOFORM_V2_CONFIG: JSON.stringify({
        documentation: "https://docs.example.invalid/takoform-v2",
        authenticationDocumentation: "https://docs.example.invalid/authentication",
        sqliteMigrationSet: { targetKey: "operator-sqlite-primary", heldArtifacts: [] },
      }),
      TAKOSERVER_TAKOFORM_V2_CURSOR_KEY: CURSOR_KEY,
    });

    expect(config.sqliteMigrationSet).toEqual({
      targetKey: "operator-sqlite-primary",
      heldArtifacts: [],
    });
  });

  test("preserves explicit WorkerBundle source identity and grants", () => {
    const heldArtifact = {
      url: "https://Artifacts.example.invalid/bundles/manifest.json",
      sha256: "2".repeat(64),
      objectKey: "operator-held/worker-bundle-manifest",
      grants: [{ principal: "org:org-b", space: "org-b" }],
    };
    const config = parseTakoformV2ApplicationConfig({
      TAKOSERVER_TAKOFORM_V2_CONFIG: JSON.stringify({
        documentation: "https://docs.example.invalid/takoform-v2",
        authenticationDocumentation: "https://docs.example.invalid/authentication",
        workerBundle: {
          targetKey: "operator-worker-bundle-target",
          heldArtifacts: [heldArtifact],
        },
      }),
      TAKOSERVER_TAKOFORM_V2_CURSOR_KEY: CURSOR_KEY,
    });

    expect(config.workerBundle).toEqual({
      targetKey: "operator-worker-bundle-target",
      heldArtifacts: [heldArtifact],
    });
    expect(config.sqliteMigrationSet).toBeUndefined();
  });

  test("allows explicit WorkerBundle deny-all while preserving omitted distinction", () => {
    const config = parseTakoformV2ApplicationConfig({
      TAKOSERVER_TAKOFORM_V2_CONFIG: JSON.stringify({
        documentation: "https://docs.example.invalid/takoform-v2",
        authenticationDocumentation: "https://docs.example.invalid/authentication",
        workerBundle: { targetKey: "operator-worker-bundle-target", heldArtifacts: [] },
      }),
      TAKOSERVER_TAKOFORM_V2_CURSOR_KEY: CURSOR_KEY,
    });

    expect(config.workerBundle).toEqual({
      targetKey: "operator-worker-bundle-target",
      heldArtifacts: [],
    });
  });

  test("preserves explicit StaticAssetBundle source identity and grants", () => {
    const heldArtifact = {
      url: "https://Artifacts.example.invalid/assets/manifest.json",
      sha256: "3".repeat(64),
      objectKey: "operator-held/static-assets-manifest",
      grants: [{ principal: "org:org-c", space: "org-c" }],
    };
    const config = parseTakoformV2ApplicationConfig({
      TAKOSERVER_TAKOFORM_V2_CONFIG: JSON.stringify({
        documentation: "https://docs.example.invalid/takoform-v2",
        authenticationDocumentation: "https://docs.example.invalid/authentication",
        staticAssetBundle: {
          targetKey: "operator-static-assets-target",
          heldArtifacts: [heldArtifact],
        },
      }),
      TAKOSERVER_TAKOFORM_V2_CURSOR_KEY: CURSOR_KEY,
    });

    expect(config.staticAssetBundle).toEqual({
      targetKey: "operator-static-assets-target",
      heldArtifacts: [heldArtifact],
    });
  });

  test("allows explicit StaticAssetBundle deny-all while preserving omitted distinction", () => {
    const config = parseTakoformV2ApplicationConfig({
      TAKOSERVER_TAKOFORM_V2_CONFIG: JSON.stringify({
        documentation: "https://docs.example.invalid/takoform-v2",
        authenticationDocumentation: "https://docs.example.invalid/authentication",
        staticAssetBundle: {
          targetKey: "operator-static-assets-target",
          heldArtifacts: [],
        },
      }),
      TAKOSERVER_TAKOFORM_V2_CURSOR_KEY: CURSOR_KEY,
    });

    expect(config.staticAssetBundle).toEqual({
      targetKey: "operator-static-assets-target",
      heldArtifacts: [],
    });
  });

  test("fails closed for missing, partial, unknown, duplicate, or malformed configuration", () => {
    const validConfig = {
      documentation: "https://docs.example.invalid/takoform-v2",
      authenticationDocumentation: "https://docs.example.invalid/authentication",
    };
    const values = [
      undefined,
      "",
      "not-json",
      JSON.stringify({ ...validConfig, unknown: true }),
      JSON.stringify({ ...validConfig, cursorSigningKey: "secret" }),
      `{"documentation":"https://docs.example.invalid/a","documentation":"https://docs.example.invalid/b","authenticationDocumentation":"https://docs.example.invalid/auth"}`,
      JSON.stringify({ ...validConfig, documentation: "http://docs.example.invalid/a" }),
      JSON.stringify({
        ...validConfig,
        sqliteMigrationSet: { targetKey: "target-without-source-map" },
      }),
      JSON.stringify({
        ...validConfig,
        sqliteMigrationSet: { targetKey: "", heldArtifacts: [] },
      }),
      JSON.stringify({
        ...validConfig,
        sqliteMigrationSet: {
          targetKey: "target",
          heldArtifacts: [
            {
              url: "https://artifacts.example.invalid/manifest.json?token=secret",
              sha256: "1".repeat(64),
              objectKey: "held/manifest",
              grants: [{ principal: "org:one", space: "one" }],
            },
          ],
        },
      }),
      JSON.stringify({
        ...validConfig,
        workerBundle: { targetKey: "operator-worker-bundle-target" },
      }),
      JSON.stringify({
        ...validConfig,
        staticAssetBundle: { targetKey: "operator-static-assets-target" },
      }),
    ];

    for (const json of values) {
      let caught: unknown;
      try {
        parseTakoformV2ApplicationConfig({
          TAKOSERVER_TAKOFORM_V2_CONFIG: json,
          TAKOSERVER_TAKOFORM_V2_CURSOR_KEY: CURSOR_KEY,
        });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(V2ApplicationConfigError);
      expect(String(caught)).not.toContain("secret");
      expect(String(caught)).not.toContain("manifest.json");
    }
  });

  test("requires a canonical unpadded base64url key of at least 32 bytes", () => {
    const json = JSON.stringify({
      documentation: "https://docs.example.invalid/takoform-v2",
      authenticationDocumentation: "https://docs.example.invalid/authentication",
    });
    for (const key of [undefined, "AQ", `${CURSOR_KEY}=`, `${CURSOR_KEY}!`]) {
      let caught: unknown;
      try {
        parseTakoformV2ApplicationConfig({
          TAKOSERVER_TAKOFORM_V2_CONFIG: json,
          TAKOSERVER_TAKOFORM_V2_CURSOR_KEY: key,
        });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(V2ApplicationConfigError);
      expect(String(caught)).not.toContain(key ?? "undefined");
    }
  });
});
