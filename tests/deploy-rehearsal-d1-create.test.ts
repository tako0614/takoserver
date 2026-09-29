import { describe, expect, test } from "bun:test";
import { DeployError } from "../scripts/deploy/errors.ts";
import type { CommandResult } from "../scripts/deploy/process.ts";
import {
  type RehearsalD1CreateDeclaration,
  type RehearsalD1CreateInvocation,
  type RehearsalD1CreateOptions,
  type RehearsalD1CreateProvider,
  runRehearsalD1Create,
} from "../scripts/deploy/rehearsal-d1-create.ts";

const COMMIT = "a".repeat(40);
const ACCOUNT_ID = "b".repeat(32);
const GENERATION = "c".repeat(32);
const DATABASE_NAME = `takoserver-r-${GENERATION}`;
const DATABASE_ID = "00000000-0000-4000-8000-000000000051";

const declaration: RehearsalD1CreateDeclaration = {
  kind: "takoserver.rehearsal-d1-create@v1",
  environment: "rehearsal",
  accountId: ACCOUNT_ID,
  name: DATABASE_NAME,
};

const invocation: RehearsalD1CreateInvocation = {
  action: "apply",
  environment: "rehearsal",
  commit: COMMIT,
};

function qualifiedSource(): RehearsalD1CreateOptions["run"] {
  return async (command) => {
    if (command.join(" ") === "git rev-parse HEAD") return ok(`${COMMIT}\n`);
    if (command.join(" ") === "git branch --show-current") return ok("rehearsal\n");
    if (command.join(" ") === "git status --porcelain=v1 -z --untracked-files=all") return ok();
    throw new Error(`unexpected qualification command: ${command.join(" ")}`);
  };
}

function ok(stdout = ""): CommandResult {
  return { exitCode: 0, stdout, stderr: "" };
}

function providerFixture(
  input: {
    readonly inventory?: readonly { readonly name: string; readonly uuid: string }[];
    readonly created?: { readonly name: string; readonly uuid: string };
    readonly readback?: { readonly name: string; readonly uuid: string };
    readonly schemaObjectCount?: number;
    readonly createFailure?: boolean;
  } = {},
): {
  readonly provider: RehearsalD1CreateProvider;
  readonly calls: string[];
} {
  const calls: string[] = [];
  const created = input.created ?? { name: DATABASE_NAME, uuid: DATABASE_ID };
  const readback = input.readback ?? created;
  const provider: RehearsalD1CreateProvider = {
    async listD1(name) {
      calls.push(`list:${name}`);
      return input.inventory ?? [];
    },
    async createD1(name) {
      calls.push(`create:${name}`);
      if (input.createFailure) throw new Error("lost create acknowledgement");
      return created;
    },
    async getD1(databaseId) {
      calls.push(`get:${databaseId}`);
      return readback;
    },
    async readSchemaObjectCount(databaseId) {
      calls.push(`schema:${databaseId}`);
      return input.schemaObjectCount ?? 0;
    },
  };
  return { provider, calls };
}

async function rejected(run: Promise<unknown>): Promise<DeployError> {
  try {
    await run;
  } catch (error) {
    expect(error).toBeInstanceOf(DeployError);
    if (!(error instanceof DeployError)) throw error;
    return error;
  }
  throw new Error("expected operation to reject");
}

describe("rehearsal D1 create", () => {
  test.each([
    ["production declaration", { ...declaration, environment: "production" }],
    ["integration declaration", { ...declaration, environment: "integration" }],
  ])("refuses %s before provider access", async (_label, invalidDeclaration) => {
    const { provider, calls } = providerFixture();
    const error = await rejected(
      runRehearsalD1Create(
        invalidDeclaration as unknown as RehearsalD1CreateDeclaration,
        invocation,
        { provider, review: "reviewed", run: qualifiedSource() },
      ),
    );
    expect(error.phase).toBe("preflight");
    expect(calls).toEqual([]);
  });

  test("refuses a non-rehearsal invocation before provider access", async () => {
    const { provider, calls } = providerFixture();
    const error = await rejected(
      runRehearsalD1Create(
        declaration,
        { ...invocation, environment: "production" } as unknown as RehearsalD1CreateInvocation,
        { provider, review: "reviewed", run: qualifiedSource() },
      ),
    );
    expect(error.phase).toBe("preflight");
    expect(calls).toEqual([]);
  });

  test("proves absence, creates once, then reads exact identity and empty schema", async () => {
    const { provider, calls } = providerFixture();
    const result = await runRehearsalD1Create(declaration, invocation, {
      provider,
      review: "independent review 123",
      run: qualifiedSource(),
    });

    expect(calls).toEqual([
      `list:${DATABASE_NAME}`,
      `list:${DATABASE_NAME}`,
      `create:${DATABASE_NAME}`,
      `get:${DATABASE_ID}`,
      `schema:${DATABASE_ID}`,
    ]);
    expect(result).toMatchObject({
      kind: "takoserver.rehearsal-d1-create-apply@v1",
      surface: "takoserver-rehearsal-d1-create",
      environment: "rehearsal",
      commit: COMMIT,
      reviewer: "independent review 123",
      databaseName: DATABASE_NAME,
      databaseId: DATABASE_ID,
      schemaObjectCount: 0,
    });
  });

  test("refuses an existing name without adoption or create", async () => {
    const { provider, calls } = providerFixture({
      inventory: [{ name: DATABASE_NAME, uuid: DATABASE_ID }],
    });
    const error = await rejected(
      runRehearsalD1Create(declaration, invocation, {
        provider,
        review: "independent review 123",
        run: qualifiedSource(),
      }),
    );
    expect(error.phase).toBe("preflight");
    expect(error.message).toContain("never adopts or resets");
    expect(calls).toEqual([`list:${DATABASE_NAME}`]);
  });

  test("refuses a wrong create identity without following it", async () => {
    const { provider, calls } = providerFixture({
      created: { name: `${DATABASE_NAME}-other`, uuid: DATABASE_ID },
    });
    const error = await rejected(
      runRehearsalD1Create(declaration, invocation, {
        provider,
        review: "independent review 123",
        run: qualifiedSource(),
      }),
    );
    expect(error.phase).toBe("mutation");
    expect(calls.filter((call) => call.startsWith("create:"))).toHaveLength(1);
    expect(calls.some((call) => call.startsWith("get:") || call.startsWith("schema:"))).toBe(false);
  });

  test("refuses a mismatched authoritative UUID/name readback", async () => {
    const { provider, calls } = providerFixture({
      readback: { name: DATABASE_NAME, uuid: "00000000-0000-4000-8000-000000000099" },
    });
    const error = await rejected(
      runRehearsalD1Create(declaration, invocation, {
        provider,
        review: "independent review 123",
        run: qualifiedSource(),
      }),
    );
    expect(error.phase).toBe("verification");
    expect(calls).toEqual([
      `list:${DATABASE_NAME}`,
      `list:${DATABASE_NAME}`,
      `create:${DATABASE_NAME}`,
      `get:${DATABASE_ID}`,
    ]);
  });

  test("refuses a nonempty post-create schema", async () => {
    const { provider, calls } = providerFixture({ schemaObjectCount: 1 });
    const error = await rejected(
      runRehearsalD1Create(declaration, invocation, {
        provider,
        review: "independent review 123",
        run: qualifiedSource(),
      }),
    );
    expect(error.phase).toBe("verification");
    expect(error.message).toContain("schema is not empty");
    expect(calls.filter((call) => call.startsWith("create:"))).toHaveLength(1);
  });

  test("lost create acknowledgement is indeterminate and never repeats the POST", async () => {
    const { provider, calls } = providerFixture({ createFailure: true });
    const error = await rejected(
      runRehearsalD1Create(declaration, invocation, {
        provider,
        review: "independent review 123",
        run: qualifiedSource(),
      }),
    );
    expect(error.phase).toBe("mutation");
    expect(error.message).toContain("indeterminate");
    expect(calls.filter((call) => call.startsWith("create:"))).toHaveLength(1);
    expect(calls.some((call) => call.startsWith("get:") || call.startsWith("schema:"))).toBe(false);
  });

  test("requires the explicit API token when using the Cloudflare adapter", async () => {
    const error = await rejected(
      runRehearsalD1Create(declaration, invocation, {
        review: "independent review 123",
        run: qualifiedSource(),
        cloudflareEnvironment: {},
      }),
    );
    expect(error.phase).toBe("preflight");
    expect(error.message).toContain("explicit CLOUDFLARE_API_TOKEN");
  });
});
