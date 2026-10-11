import { describe, expect, test } from "bun:test";
import { createEphemeralSql } from "../src/index.ts";
import {
  parseSelfhostOperatorAssertionPrint,
  renderSelfhostOperatorSignInInstructions,
  SELFHOST_OPERATOR_ASSERTION_PRINT_VARIABLE,
  SELFHOST_OPERATOR_SIGN_IN_IDENTITY,
  selfhostOperatorAssertionDue,
} from "../src/selfhost-startup-instructions.ts";

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
    expect(output).toContain("opens one session");
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
    expect(output).toMatch(
      /Operator sign-in assertion \(valid 10 minutes\):\s+fake-operator-assertion/u,
    );
  });

  test("the later-assertion command signs for this Host's audience, not the CLI default", () => {
    for (const assertion of ["fake-operator-assertion", undefined]) {
      const output = renderSelfhostOperatorSignInInstructions({
        publicOrigin: "https://api.example.test",
        ...(assertion ? { assertion } : {}),
        operatorKeyPath: "/tmp/fake-operator-key.jwk",
      });
      expect(output).toContain(
        "bun scripts/operator-key.ts sign-in google operator operator@localhost Operator",
      );
      expect(output).toContain("TAKOSERVER_OPERATOR_KEY=/tmp/fake-operator-key.jwk");
      expect(output).toContain("TAKOSERVER_PUBLIC_ORIGIN=https://api.example.test");
    }
  });

  test("once the operator has signed in, the reminder prints no credential", () => {
    const output = renderSelfhostOperatorSignInInstructions({
      publicOrigin: "https://api.example.test",
      consoleOrigin: "https://console.example.test",
      operatorKeyPath: "/tmp/fake-operator-key.jwk",
    });

    expect(output).not.toContain("valid 10 minutes");
    expect(output).not.toContain("paste this");
    expect(output).not.toMatch(/[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/u);
    expect(output).toContain("already signed in");
    expect(output).toContain(`${SELFHOST_OPERATOR_ASSERTION_PRINT_VARIABLE}=1`);
    expect(output).toContain(
      "bun scripts/operator-key.ts sign-in google operator operator@localhost Operator",
    );
  });
});

describe("whether a boot prints the operator sign-in assertion", () => {
  test("the print override accepts only an explicit 1 or 0", () => {
    expect(SELFHOST_OPERATOR_ASSERTION_PRINT_VARIABLE).toBe("TAKOSERVER_PRINT_OPERATOR_ASSERTION");
    expect(parseSelfhostOperatorAssertionPrint(undefined)).toBe(false);
    expect(parseSelfhostOperatorAssertionPrint("0")).toBe(false);
    expect(parseSelfhostOperatorAssertionPrint("1")).toBe(true);
    for (const value of ["", " ", "true", "yes", "01", "1 "]) {
      expect(() => parseSelfhostOperatorAssertionPrint(value)).toThrow(
        /TAKOSERVER_PRINT_OPERATOR_ASSERTION must be 1 or 0/u,
      );
    }
  });

  test("prints until the operator account exists, then only when explicitly asked", async () => {
    const sql = createEphemeralSql();
    expect(await selfhostOperatorAssertionDue({ sql, forced: false })).toBe(true);

    // An unrelated principal is not the operator having signed in.
    await sql.run(
      `INSERT INTO principals (id, provider, provider_subject, email, display_name, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      ["prn_other", "google", "someone-else", "x@example.test", "X", new Date(0).toISOString()],
    );
    expect(await selfhostOperatorAssertionDue({ sql, forced: false })).toBe(true);

    await sql.run(
      `INSERT INTO principals (id, provider, provider_subject, email, display_name, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        "prn_operator",
        SELFHOST_OPERATOR_SIGN_IN_IDENTITY.provider,
        SELFHOST_OPERATOR_SIGN_IN_IDENTITY.subject,
        SELFHOST_OPERATOR_SIGN_IN_IDENTITY.email,
        SELFHOST_OPERATOR_SIGN_IN_IDENTITY.displayName,
        new Date(0).toISOString(),
      ],
    );
    expect(await selfhostOperatorAssertionDue({ sql, forced: false })).toBe(false);
    expect(await selfhostOperatorAssertionDue({ sql, forced: true })).toBe(true);
  });
});
