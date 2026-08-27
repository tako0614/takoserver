import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeployError } from "../scripts/deploy/errors.ts";
import { runStaticSite, type StaticProcess } from "../scripts/deploy/static.ts";

const INDEX = "<!doctype html><title>Takoserver</title>\n";

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "takoserver-static-deploy-"));
  mkdirSync(join(directory, "ja"));
  writeFileSync(join(directory, "index.html"), INDEX);
  writeFileSync(join(directory, "ja", "index.html"), INDEX);
  return directory;
}

function fakeProcess(options: {
  readonly directory: string;
  readonly branch?: string;
  readonly dirty?: string;
  readonly upload?: (command: readonly string[]) => {
    exitCode: number;
    stdout?: string;
    stderr?: string;
  };
  readonly failBuild?: boolean;
}) {
  const calls: readonly string[][] = [] as string[][];
  const mutableCalls = calls as string[][];
  const run: StaticProcess = async (command) => {
    mutableCalls.push([...command]);
    const key = command.join(" ");
    if (command[0] === "git" && command[1] === "branch") {
      return { exitCode: 0, stdout: `${options.branch ?? "feature/site"}\n`, stderr: "" };
    }
    if (command[0] === "git" && command[1] === "status") {
      return { exitCode: 0, stdout: options.dirty ?? " M src/landing.ts\n", stderr: "" };
    }
    if (command[0] === "git" && command[1] === "rev-parse" && command[2] === "HEAD") {
      return { exitCode: 0, stdout: `${"a".repeat(40)}\n`, stderr: "" };
    }
    if (command[0] === "git" && command[1] === "fetch") {
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    if (command[0] === "git" && command[1] === "rev-parse" && command[2] === "origin/main") {
      return { exitCode: 0, stdout: `${"a".repeat(40)}\n`, stderr: "" };
    }
    if (command[0] === "bun" && command[1] === "scripts/build-site.ts") {
      if (options.failBuild) return { exitCode: 1, stdout: "", stderr: "build failed" };
      const out = command[command.indexOf("--out") + 1];
      if (typeof out !== "string") throw new Error("fake build did not receive --out");
      mkdirSync(join(out, "ja"), { recursive: true });
      writeFileSync(join(out, "index.html"), INDEX);
      writeFileSync(join(out, "ja", "index.html"), INDEX);
      return { exitCode: 0, stdout: `site built into ${out}\n`, stderr: "" };
    }
    if (command.includes("pages") && command.includes("deploy")) {
      const result = options.upload?.(command) ?? {
        exitCode: 0,
        stdout: "✨ Deployment complete! https://abc123.takoserver-website.pages.dev\n",
        stderr: "",
      };
      return {
        exitCode: result.exitCode,
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
      };
    }
    throw new Error(`unexpected fake command: ${key}`);
  };
  return { run, calls: mutableCalls };
}

function fetcherFor(body = INDEX) {
  const requests: { input: string; init?: RequestInit }[] = [];
  const fetcher = async (input: string, init?: RequestInit): Promise<Response> => {
    requests.push(init === undefined ? { input } : { input, init });
    return new Response(body, { status: 200 });
  };
  return { fetcher, requests };
}

describe("routine Takoserver Pages publication", () => {
  test("accepts a dirty non-main integration worktree and uploads once", async () => {
    const directory = fixture();
    try {
      const fake = fakeProcess({ directory });
      const { fetcher, requests } = fetcherFor();
      const result = await runStaticSite(["--environment=integration"], {
        run: fake.run,
        fetcher,
      });

      expect(result.environment).toBe("integration");
      expect(result.branch).toBe("feature/site");
      expect(result.commitDirty).toBe(true);
      expect(result.project).toBe("takoserver-website");
      expect(fake.calls.filter((call) => call.includes("scripts/build-site.ts"))).toHaveLength(1);
      expect(
        fake.calls.filter((call) => call.includes("pages") && call.includes("deploy")),
      ).toHaveLength(1);
      const upload = fake.calls.find((call) => call.includes("pages") && call.includes("deploy"));
      expect(upload).toEqual(
        expect.arrayContaining([
          "pages",
          "deploy",
          "--project-name",
          "takoserver-website",
          "--branch",
          "feature/site",
          "--commit-dirty=true",
        ]),
      );
      expect(requests.map((request) => request.input)).toEqual([
        "https://abc123.takoserver-website.pages.dev/",
      ]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("refuses a dirty production worktree before building or uploading", async () => {
    const directory = fixture();
    try {
      const fake = fakeProcess({ directory, branch: "main", dirty: " M src/landing.ts\n" });
      const failure = await runStaticSite(["--environment=production"], { run: fake.run }).catch(
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(DeployError);
      expect(failure).toMatchObject({ phase: "preflight" });
      expect((failure as DeployError).message).toContain("clean");
      expect(fake.calls.some((call) => call.includes("scripts/build-site.ts"))).toBe(false);
      expect(fake.calls.some((call) => call.includes("pages") && call.includes("deploy"))).toBe(
        false,
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("classifies a build failure before upload as preflight", async () => {
    const directory = fixture();
    try {
      const fake = fakeProcess({ directory, failBuild: true });
      const failure = await runStaticSite(["--environment=integration"], { run: fake.run }).catch(
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(DeployError);
      expect(failure).toMatchObject({ phase: "preflight" });
      expect(
        fake.calls.filter((call) => call.includes("pages") && call.includes("deploy")),
      ).toHaveLength(0);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("classifies an upload acknowledgement failure as indeterminate mutation", async () => {
    const directory = fixture();
    try {
      const fake = fakeProcess({
        directory,
        upload: () => ({ exitCode: 1, stderr: "upload acknowledgement lost" }),
      });
      const { fetcher, requests } = fetcherFor();
      const failure = await runStaticSite(["--environment=integration"], {
        run: fake.run,
        fetcher,
      }).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(DeployError);
      expect(failure).toMatchObject({ phase: "mutation" });
      expect((failure as DeployError).message).toContain("indeterminate");
      expect(requests).toHaveLength(0);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("classifies a post-upload readback mismatch as verification", async () => {
    const directory = fixture();
    try {
      const fake = fakeProcess({ directory });
      const { fetcher, requests } = fetcherFor("stale bytes");
      const failure = await runStaticSite(["--environment=integration"], {
        run: fake.run,
        fetcher,
      }).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(DeployError);
      expect(failure).toMatchObject({ phase: "verification" });
      expect((failure as DeployError).message).toContain("bytes differ");
      expect(
        fake.calls.filter((call) => call.includes("pages") && call.includes("deploy")),
      ).toHaveLength(1);
      expect(requests).toHaveLength(1);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("reads back immutable deployment and production custom domain once", async () => {
    const directory = fixture();
    try {
      const fake = fakeProcess({ directory, branch: "main", dirty: "" });
      const { fetcher, requests } = fetcherFor();
      const result = await runStaticSite(["--environment", "production"], {
        run: fake.run,
        fetcher,
      });
      expect(result.environment).toBe("production");
      expect(result.commitDirty).toBe(false);
      expect(result.immutableUrl).toBe("https://abc123.takoserver-website.pages.dev/");
      expect(requests.map((request) => request.input)).toEqual([
        "https://abc123.takoserver-website.pages.dev/",
        "https://takoserver.com/",
      ]);
      expect(requests.every((request) => request.init?.method === "GET")).toBe(true);
      const upload = fake.calls.find((call) => call.includes("pages") && call.includes("deploy"));
      expect(upload).toEqual(expect.arrayContaining(["--branch", "main", "--commit-dirty=false"]));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
