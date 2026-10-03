import { describe, expect, test } from "bun:test";
import { renderSelfhostOperatorSignInInstructions } from "../src/selfhost-startup-instructions.ts";

describe("self-host operator sign-in startup instructions", () => {
  test("directs to the configured console origin without inventing a Host console route", () => {
    const output = renderSelfhostOperatorSignInInstructions({
      publicOrigin: "https://api.example.test",
      consoleOrigin: "https://console.example.test",
      assertion: "fake-operator-assertion",
      operatorKeyPath: "/tmp/fake-operator-key.jwk",
    });

    expect(output).toContain("open https://console.example.test and paste this");
    expect(output).not.toMatch(/https:\/\/[^/\s]+\/console/u);
    expect(output).toContain("fake-operator-assertion");
    expect(output).toContain("valid 10 minutes");
    expect(output).toContain("TAKOSERVER_OPERATOR_KEY=/tmp/fake-operator-key.jwk");
  });

  test("without a console, directs to the Host and API documentation without guessing a destination", () => {
    const output = renderSelfhostOperatorSignInInstructions({
      publicOrigin: "https://api.example.test",
      assertion: "fake-operator-assertion",
      operatorKeyPath: "/tmp/fake-operator-key.jwk",
    });

    expect(output).toContain("This Host serves its landing page and API, not a console.");
    expect(output).toContain("https://api.example.test/");
    expect(output).toContain("https://api.example.test/openapi.json");
    expect(output).toContain("POST https://api.example.test/v1/sessions");
    expect(output).toContain(
      "/v1/me, /v1/organizations, and /v1/organizations/{organizationId}/api-keys",
    );
    expect(output).toContain("docs/self-host-operations.md");
    expect(output).not.toMatch(/https:\/\/[^/\s]+\/console/u);
    expect(output).not.toContain("console.takoserver.com");
    expect(output).toContain("fake-operator-assertion");
    expect(output).toContain("valid 10 minutes");
  });
});
