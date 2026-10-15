import { writeFileSync } from "node:fs";
import { isAbsolute } from "node:path";

// This preload runs only in the CLI child. Every fetch is checked and answered
// locally; this fixture has no network fallback.
const scenario = process.env.TRANSFER_CLI_SCENARIO;
const reportPath = process.env.TRANSFER_CLI_REPORT_PATH;
if (!scenario || !reportPath || !isAbsolute(reportPath)) {
  throw new Error("transfer CLI fixture scenario/report path is missing");
}
const safeReportPath = reportPath as string;

const accountId = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const databaseId = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const organizationId = "org_cli";
const email = "owner@example.test";
const oldOwner = "principal_old";
const newOwner = "principal_new";
const endpoint = `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}/query`;
const orgSql = "SELECT id, name, owner_principal_id FROM orgs WHERE id = ?";
const principalSql =
  "SELECT id, provider, provider_subject, display_name FROM principals WHERE email = ?";
const transferSql =
  "UPDATE orgs SET owner_principal_id = ? WHERE id = ? AND owner_principal_id = ?";

const countByScenario: Readonly<Record<string, unknown>> = {
  "apply-one": 1,
  "apply-two": 2,
  "apply-four": 4,
  "apply-zero": 0,
  "apply-negative": -1,
  "apply-fractional": 1.5,
  "apply-unsafe": Number.MAX_SAFE_INTEGER + 1,
  "apply-malformed": "2",
};
const known = new Set([
  ...Object.keys(countByScenario),
  "dry-run",
  "same-owner",
  "no-organization",
  "no-principal",
  "ambiguous-principal",
]);
if (!known.has(scenario)) throw new Error(`unknown transfer CLI fixture: ${scenario}`);

const expected: {
  readonly sql: string;
  readonly params: readonly string[];
  readonly results: readonly Record<string, unknown>[];
  readonly changes: unknown;
}[] = [
  {
    sql: orgSql,
    params: [organizationId],
    results:
      scenario === "no-organization"
        ? []
        : [
            {
              id: organizationId,
              name: "CLI Org",
              owner_principal_id: scenario === "same-owner" ? newOwner : oldOwner,
            },
          ],
    changes: 0,
  },
];
if (scenario !== "no-organization") {
  expected.push({
    sql: principalSql,
    params: [email],
    results:
      scenario === "no-principal"
        ? []
        : scenario === "ambiguous-principal"
          ? [
              {
                id: newOwner,
                provider: "google",
                provider_subject: "subject_new",
                display_name: "New Owner",
              },
              {
                id: "principal_other",
                provider: "google",
                provider_subject: "subject_other",
                display_name: "Other",
              },
            ]
          : [
              {
                id: newOwner,
                provider: "google",
                provider_subject: "subject_new",
                display_name: "New Owner",
              },
            ],
    changes: 0,
  });
}
if (scenario in countByScenario) {
  expected.push({
    sql: transferSql,
    params: [newOwner, organizationId, oldOwner],
    results: [],
    changes: countByScenario[scenario],
  });
}

let seen = 0;
const errors: string[] = [];
function writeReport(): void {
  writeFileSync(
    safeReportPath,
    `${JSON.stringify({ seen, expected: expected.length, errors })}\n`,
    {
      mode: 0o600,
    },
  );
}

writeReport();
globalThis.fetch = Object.assign(
  async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = input instanceof Request ? input : new Request(input, init);
    const step = expected[seen];
    seen += 1;
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      errors.push("request body is not JSON");
    }
    if (
      request.url !== endpoint ||
      request.method !== "POST" ||
      request.headers.get("authorization") !== "Bearer LOCAL_ONLY_TEST_TOKEN" ||
      request.headers.get("accept") !== "application/json" ||
      request.headers.get("content-type") !== "application/json" ||
      step === undefined ||
      JSON.stringify(body) !== JSON.stringify({ sql: step.sql, params: step.params })
    ) {
      errors.push(
        `unexpected D1 request ${seen}: ${request.method} ${request.url} ${JSON.stringify(body)}`,
      );
      writeReport();
      return Response.json(
        { success: false, errors: [{ message: "fixture rejected unexpected request" }] },
        { status: 418 },
      );
    }
    writeReport();
    return Response.json({
      success: true,
      result: [{ results: step.results, meta: { changes: step.changes } }],
    });
  },
  { preconnect: () => {} },
);
