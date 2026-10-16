import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Run the candidate CLI itself with its natural relative D1 adapter import;
// the child preload intercepts every fetch and answers locally.
const candidate = new URL("../scripts/transfer-organization.ts", import.meta.url).pathname;
const preload = new URL("./fixtures/transfer-organization-cli.preload.ts", import.meta.url)
  .pathname;
const organizationId = "org_cli";
const email = "owner@example.test";

async function runCli(
  scenario: string,
  apply: boolean,
): Promise<{
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly requests: number;
}> {
  const directory = mkdtempSync(join(tmpdir(), "takos-transfer-cli-"));
  const reportPath = join(directory, "fetch-report.json");
  try {
    const child = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        "--preload",
        preload,
        candidate,
        organizationId,
        email,
        ...(apply ? ["--apply"] : []),
      ],
      {
        env: {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          CLOUDFLARE_ACCOUNT_ID: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          TAKOSERVER_D1_DATABASE_ID: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
          CLOUDFLARE_API_TOKEN: "LOCAL_ONLY_TEST_TOKEN",
          TRANSFER_CLI_SCENARIO: scenario,
          TRANSFER_CLI_REPORT_PATH: reportPath,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const code = await Promise.race([
      child.exited,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(async () => {
          child.kill("SIGKILL");
          await child.exited;
          reject(new Error(`transfer CLI timed out: ${scenario}`));
        }, 5_000);
      }),
    ]).finally(() => {
      if (timeout !== undefined) clearTimeout(timeout);
    });
    const [stdout, stderr] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    if (!existsSync(reportPath)) {
      throw new Error(
        `transfer CLI fixture did not report; code=${code}; stdout=${stdout}; stderr=${stderr}`,
      );
    }
    const report = JSON.parse(readFileSync(reportPath, "utf8")) as {
      seen: number;
      expected: number;
      errors: string[];
    };
    expect(report.errors).toEqual([]);
    expect(report.seen).toBe(report.expected);
    return { code, stdout, stderr, requests: report.seen };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

for (const [scenario, expectedChanges] of [
  ["apply-one", 1],
  ["apply-two", 2],
  ["apply-four", 4],
] as const) {
  test(`actual transfer CLI accepts positive raw D1 meta.changes=${expectedChanges}`, async () => {
    const result = await runCli(scenario, true);
    expect(result.code).toBe(0);
    expect(result.requests).toBe(3);
    expect(result.stdout).toContain(`transferred to ${email}`);
    expect(result.stderr).not.toContain("could not be confirmed");
  });
}

for (const scenario of [
  "apply-zero",
  "apply-negative",
  "apply-fractional",
  "apply-unsafe",
  "apply-malformed",
]) {
  test(`actual transfer CLI refuses ${scenario} raw D1 write count`, async () => {
    const result = await runCli(scenario, true);
    expect(result.code).toBe(1);
    expect(result.requests).toBe(3);
    expect(result.stderr).toContain(
      "transfer could not be confirmed; inspect the organization before retrying",
    );
    expect(result.stdout).not.toContain(`transferred to ${email}`);
  });
}

test("actual transfer CLI dry run performs only the two reads", async () => {
  const result = await runCli("dry-run", false);
  expect(result.code).toBe(0);
  expect(result.requests).toBe(2);
  expect(result.stdout).toContain("plan only: nothing was written");
});

test("actual transfer CLI same-owner path performs only the two reads", async () => {
  const result = await runCli("same-owner", true);
  expect(result.code).toBe(0);
  expect(result.requests).toBe(2);
  expect(result.stdout).toContain(`is already owned by ${email}`);
  expect(result.stdout).not.toContain(`transferred to ${email}`);
});

test("actual transfer CLI refuses absent organization before principal lookup", async () => {
  const result = await runCli("no-organization", true);
  expect(result.code).toBe(1);
  expect(result.requests).toBe(1);
  expect(result.stderr).toContain(`no organization ${organizationId}`);
});

test("actual transfer CLI refuses absent principal before the write", async () => {
  const result = await runCli("no-principal", true);
  expect(result.code).toBe(1);
  expect(result.requests).toBe(2);
  expect(result.stderr).toContain(`no principal with email ${email}`);
});

test("actual transfer CLI refuses ambiguous principal before the write", async () => {
  const result = await runCli("ambiguous-principal", true);
  expect(result.code).toBe(1);
  expect(result.requests).toBe(2);
  expect(result.stderr).toContain(`2 principals share ${email}; refusing to guess`);
});
