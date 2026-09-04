import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeployError } from "../scripts/deploy/errors.ts";
import { runStaticSite, type SiteState, type StaticProcess } from "../scripts/deploy/static.ts";

const COMMIT = "a".repeat(40);
const INDEX = "<!doctype html><title>Takoserver</title>\n";

function fakeProcess(
  input: { readonly branch?: string; readonly dirty?: string; readonly uploadExit?: number } = {},
): { readonly run: StaticProcess; readonly calls: string[][] } {
  const calls: string[][] = [];
  const run: StaticProcess = async (command) => {
    calls.push([...command]);
    const key = command.join(" ");
    if (key === "git rev-parse HEAD") return ok(`${COMMIT}\n`);
    if (key === "git branch --show-current") return ok(`${input.branch ?? "feature/site"}\n`);
    if (key === "git status --porcelain=v1 -z --untracked-files=all") {
      return ok(input.dirty ?? "");
    }
    if (key === "git fetch --quiet origin main") return ok("");
    if (key === "git rev-parse origin/main") return ok(`${COMMIT}\n`);
    if (command[0] === "bun" && command[1] === "scripts/build-site.ts") {
      const out = command[command.indexOf("--out") + 1];
      if (!out) throw new Error("build output missing");
      mkdirSync(join(out, "ja"), { recursive: true });
      writeFileSync(join(out, "index.html"), INDEX);
      writeFileSync(join(out, "ja", "index.html"), INDEX);
      return ok("");
    }
    if (command.includes("pages") && command.includes("deploy")) {
      return input.uploadExit
        ? { exitCode: input.uploadExit, stdout: "", stderr: "acknowledgement lost" }
        : ok("Deployment complete https://new.takoserver-website.pages.dev/\n");
    }
    throw new Error(`unexpected command: ${key}`);
  };
  return { run, calls };
}

function ok(stdout: string) {
  return { exitCode: 0, stdout, stderr: "" };
}

function pagesDeployment(input: {
  id: string;
  url: string;
  commit: string;
  created: string;
  environment?: "production" | "preview";
}) {
  return {
    id: input.id,
    url: input.url,
    created_on: input.created,
    environment: input.environment ?? "preview",
    latest_stage: { status: "success" },
    deployment_trigger: { metadata: { commit_hash: input.commit } },
  };
}

function stateSequence(
  values: readonly (readonly unknown[])[],
): SiteState & { readonly reads: number } {
  let reads = 0;
  return {
    get reads() {
      return reads;
    },
    async pagesDeployments() {
      const value = values[Math.min(reads, values.length - 1)] ?? [];
      reads += 1;
      return value;
    },
  };
}

describe("routine Takoserver Pages surface", () => {
  test("status is read-only and reports authoritative selected-commit state", async () => {
    const state = stateSequence([
      [
        pagesDeployment({
          id: "deployment-current",
          url: "https://current.takoserver-website.pages.dev",
          commit: COMMIT,
          created: "2026-08-28T01:00:00Z",
          environment: "production",
        }),
      ],
    ]);
    const result = await runStaticSite(
      { action: "status", environment: "production", commit: COMMIT },
      { state, cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" } },
    );
    expect(result).toMatchObject({
      kind: "takoserver.site-status@v2",
      currentDeploymentId: "deployment-current",
      commitMatches: true,
    });
    expect(state.reads).toBe(1);
  });

  test("builds, seals, uploads, and reads one immutable URL exactly once", async () => {
    const root = mkdtempSync(join(tmpdir(), "takoserver-site-surface-"));
    try {
      const process = fakeProcess({ dirty: " M src/landing.ts\0" });
      const previous = pagesDeployment({
        id: "deployment-previous",
        url: "https://previous.takoserver-website.pages.dev",
        commit: "b".repeat(40),
        created: "2026-08-28T01:00:00Z",
      });
      const current = pagesDeployment({
        id: "deployment-current",
        url: "https://new.takoserver-website.pages.dev",
        commit: COMMIT,
        created: "2026-08-28T02:00:00Z",
      });
      const state = stateSequence([[previous], [current, previous]]);
      const requests: string[] = [];
      const result = await runStaticSite(
        { action: "apply", environment: "integration", commit: COMMIT },
        {
          run: process.run,
          state,
          outputDirectory: root,
          cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
          fetcher: async (input) => {
            requests.push(input);
            return new Response(INDEX, { status: 200 });
          },
        },
      );
      expect(result).toMatchObject({
        kind: "takoserver.site-apply@v2",
        previousDeploymentId: "deployment-previous",
        deploymentId: "deployment-current",
        immutableUrl: "https://new.takoserver-website.pages.dev/",
      });
      expect(process.calls.filter((call) => call.includes("scripts/build-site.ts"))).toHaveLength(
        1,
      );
      expect(
        process.calls.filter((call) => call.includes("pages") && call.includes("deploy")),
      ).toHaveLength(1);
      expect(requests).toEqual(["https://new.takoserver-website.pages.dev/"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("production additionally proves the custom-domain bytes exactly", async () => {
    const root = mkdtempSync(join(tmpdir(), "takoserver-site-production-"));
    try {
      const process = fakeProcess({ branch: "main" });
      const previous = pagesDeployment({
        id: "deployment-previous",
        url: "https://previous.takoserver-website.pages.dev",
        commit: "b".repeat(40),
        created: "2026-08-28T01:00:00Z",
        environment: "production",
      });
      const current = pagesDeployment({
        id: "deployment-current",
        url: "https://new.takoserver-website.pages.dev",
        commit: COMMIT,
        created: "2026-08-28T02:00:00Z",
        environment: "production",
      });
      const requests: string[] = [];
      const result = await runStaticSite(
        { action: "apply", environment: "production", commit: COMMIT },
        {
          run: process.run,
          state: stateSequence([[previous], [current, previous]]),
          outputDirectory: root,
          accountId: "a".repeat(32),
          cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
          fetcher: async (input) => {
            requests.push(input);
            return new Response(INDEX, { status: 200 });
          },
        },
      );
      expect(result.productionReadback).toMatchObject({
        url: "https://takoserver.com/",
        status: 200,
      });
      expect(requests).toEqual([
        "https://new.takoserver-website.pages.dev/",
        "https://takoserver.com/",
      ]);
      expect(
        process.calls.filter((call) => call.includes("pages") && call.includes("deploy")),
      ).toHaveLength(1);
      expect(result.rollback).toContain(
        "/pages/projects/takoserver-website/deployments/deployment-previous/rollback",
      );
      expect(result.rollback).toContain("$CLOUDFLARE_API_TOKEN");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("production rollback selects the previous successful production deployment", async () => {
    const root = mkdtempSync(join(tmpdir(), "takoserver-site-production-history-"));
    try {
      const process = fakeProcess({ branch: "main" });
      const previousProduction = pagesDeployment({
        id: "deployment-production-previous",
        url: "https://previous-production.takoserver-website.pages.dev",
        commit: "b".repeat(40),
        created: "2026-08-28T01:00:00Z",
        environment: "production",
      });
      const newerPreview = pagesDeployment({
        id: "deployment-preview-newer",
        url: "https://preview-newer.takoserver-website.pages.dev",
        commit: "c".repeat(40),
        created: "2026-08-28T01:30:00Z",
      });
      const current = pagesDeployment({
        id: "deployment-production-current",
        url: "https://new.takoserver-website.pages.dev",
        commit: COMMIT,
        created: "2026-08-28T02:00:00Z",
        environment: "production",
      });
      const result = await runStaticSite(
        { action: "apply", environment: "production", commit: COMMIT },
        {
          run: process.run,
          state: stateSequence([
            [newerPreview, previousProduction],
            [current, newerPreview, previousProduction],
          ]),
          outputDirectory: root,
          cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
          fetcher: async () => new Response(INDEX, { status: 200 }),
          accountId: "a".repeat(32),
        },
      );
      expect(result.previousDeploymentId).toBe("deployment-production-previous");
      expect(result.rollback).toContain("deployment-production-previous/rollback");
      expect(result.rollback).not.toContain("deployment-preview-newer");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("classifies a lost upload acknowledgement as indeterminate and never reads bytes", async () => {
    const root = mkdtempSync(join(tmpdir(), "takoserver-site-failure-"));
    try {
      const process = fakeProcess({ uploadExit: 1 });
      const state = stateSequence([[]]);
      const requests: string[] = [];
      const failure = await runStaticSite(
        { action: "apply", environment: "rehearsal", commit: COMMIT },
        {
          run: process.run,
          state,
          outputDirectory: root,
          cloudflareEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
          fetcher: async (input) => {
            requests.push(input);
            return new Response(INDEX);
          },
        },
      ).catch((error) => error);
      expect(failure).toBeInstanceOf(DeployError);
      expect(failure).toMatchObject({ phase: "mutation" });
      expect(requests).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
