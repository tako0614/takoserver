import { expect, test } from "bun:test";
import { resolveCloudflareRouteToken } from "../scripts/deploy/cloudflare-auth.ts";
import { DeployError } from "../scripts/deploy/errors.ts";

test("site route authority uses the authenticated Wrangler profile when no env token exists", async () => {
  const commands: readonly string[][] = [];
  const recorded = commands as string[][];
  const token = await resolveCloudflareRouteToken({
    env: {},
    run: async (command) => {
      recorded.push([...command]);
      return {
        exitCode: 0,
        stdout: JSON.stringify({ type: "oauth", token: "wrangler-managed-route-token" }),
        stderr: "",
      };
    },
  });

  expect(commands).toEqual([[expect.stringContaining("wrangler"), "auth", "token", "--json"]]);
  expect(token).toBe("wrangler-managed-route-token");
  expect(commands.flat().join(" ")).not.toContain(token);
});

test("site route authority refuses incomplete Wrangler metadata without disclosing it", async () => {
  const secret = "oauth-secret-that-must-not-escape";
  const failure = await resolveCloudflareRouteToken({
    env: {},
    run: async () => ({
      exitCode: 0,
      stdout: JSON.stringify({ token: secret }),
      stderr: `unexpected credential ${secret}`,
    }),
  }).catch((error: unknown) => error);

  expect(failure).toBeInstanceOf(DeployError);
  expect(failure).toMatchObject({
    phase: "preflight",
    message: "Wrangler returned invalid authentication metadata",
  });
  expect(JSON.stringify(failure)).not.toContain(secret);
  expect(String(failure)).not.toContain(secret);
});

test("site route authority sanitizes a failed Wrangler auth command", async () => {
  const secret = "oauth-command-secret-that-must-not-escape";
  const failure = await resolveCloudflareRouteToken({
    env: {},
    run: async () => ({
      exitCode: 1,
      stdout: JSON.stringify({ type: "oauth", token: secret }),
      stderr: `authentication failed around ${secret}`,
    }),
  }).catch((error: unknown) => error);

  expect(failure).toBeInstanceOf(DeployError);
  expect(failure).toMatchObject({
    phase: "preflight",
    message: "Wrangler authentication is required for web route authority",
  });
  expect(JSON.stringify(failure)).not.toContain(secret);
  expect(String(failure)).not.toContain(secret);
});

test("site route authority accepts an existing env token without invoking Wrangler", async () => {
  let invoked = false;
  const token = await resolveCloudflareRouteToken({
    env: { CLOUDFLARE_API_TOKEN: "existing-route-inventory-token" },
    run: async () => {
      invoked = true;
      throw new Error("Wrangler must not run when the operator already supplied authority");
    },
  });

  expect(token).toBe("existing-route-inventory-token");
  expect(invoked).toBe(false);
});
