import type { V2ApplicationConfig } from "../../src/takoform-v2/config.ts";

/** Fixture-only explicit v2 Host config with no Forms advertised. */
export const TEST_TAKOFORM_V2_CONFIG: V2ApplicationConfig = {
  cursorSigningKey: new Uint8Array(32).fill(0x5a),
  documentation: "https://docs.example.invalid/takoform-v2",
  authenticationDocumentation: "https://docs.example.invalid/takoform-v2/authentication",
};
