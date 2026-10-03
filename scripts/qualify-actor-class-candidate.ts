/**
 * Source-only Actor class inspection of the exact unpublished PR11 input.
 * This never binds a Host runtime or treats a class verdict as Form support.
 * Every tenant module import, factory call and reflection runs in a killable
 * child, as the self-host Actor owner does for its native process.
 */
import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import { inspectActorClassV2Candidate } from "../src/actor-class-candidate-inspection.ts";

const SOURCE_COMMIT = "029ebd9c69db4ea6b7d280f74b7f6b6447d2a84a";
const CORPUS_PATH = "conformance/edge-runtime/actor-workflow";
const MANIFEST_SHA256 = "fd370a76006a6853586317594fbfdfffa92c630272825f1d95b82815453cefbe";
const BUNDLE_SHA256 = "82ffdf63818c1a052142c95c62b3e2e66c668ed3872b403f4462d833a04736d9";
const CASES_SHA256 = "bc85ae8d24cded6fdf28eaf222dd4b1db40f5c9024ba63612902524d43052fbd";
const INSPECTION_DEADLINE_MS = 3_000;
const TERMINATION_DEADLINE_MS = 1_000;

const ACTOR_CASES = [
  { id: "ordinary-actor-five-handlers", expected: "admit" },
  { id: "finite-deep-inherited-five-handlers", expected: "admit" },
  { id: "cyclic-proxy-prototype", expected: "refuse" },
  { id: "changing-proxy-prototype", expected: "refuse" },
  { id: "nonreturning-proxy-prototype", expected: "timeout-refusal" },
] as const;

type ActorCaseId = (typeof ACTOR_CASES)[number]["id"];
type ChildVerdict = "admit" | "refuse" | "unexpected";

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function pinnedBlob(root: string, name: "manifest.json" | "bundle.mjs" | "cases.json"): Uint8Array {
  const result = Bun.spawnSync(
    ["git", "-C", root, "show", `${SOURCE_COMMIT}:${CORPUS_PATH}/${name}`],
    { stdout: "pipe", stderr: "pipe" },
  );
  if (result.exitCode !== 0) {
    throw new Error(`PR11 ${name} is unavailable at the selected source commit`);
  }
  return result.stdout;
}

function requireDigest(bytes: Uint8Array, digest: string, name: string): void {
  if (sha256(bytes) !== digest) throw new Error(`PR11 ${name} digest mismatch`);
}

function parseSelectedCorpus(manifestBytes: Uint8Array, casesBytes: Uint8Array): void {
  const manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as {
    status?: unknown;
    bundle?: { path?: unknown; sha256?: unknown };
    cases?: { path?: unknown; sha256?: unknown };
    interfaces?: Array<{ name?: unknown; version?: unknown }>;
  };
  if (
    manifest.status !== "unpublished-source-input" ||
    manifest.bundle?.path !== "bundle.mjs" ||
    manifest.bundle.sha256 !== BUNDLE_SHA256 ||
    manifest.cases?.path !== "cases.json" ||
    manifest.cases.sha256 !== CASES_SHA256 ||
    !manifest.interfaces?.some(
      (entry) => entry.name === "worker.actor" && entry.version === "2.0.0",
    )
  ) {
    throw new Error("PR11 selected Actor manifest identity mismatch");
  }
  const cases = JSON.parse(new TextDecoder().decode(casesBytes)) as {
    status?: unknown;
    cases?: Array<{ id?: unknown }>;
  };
  const ids = cases.cases?.map((entry) => entry.id);
  if (
    cases.status !== "not-run-without-consumer-adapter" ||
    ids?.length !== 6 ||
    ACTOR_CASES.some((entry, index) => ids[index] !== entry.id) ||
    ids[5] !== "workflow-step-and-signal"
  ) {
    throw new Error("PR11 selected Actor case set mismatch");
  }
}

function exitWithin(child: ReturnType<typeof Bun.spawn>, millis: number): Promise<number | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), millis);
    void child.exited.then((code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

async function inspectInChild(
  id: ActorCaseId,
  bundleDataUrl: string,
): Promise<ChildVerdict | "timeout-refusal"> {
  const child = Bun.spawn([process.execPath, import.meta.path, "--child", id, bundleDataUrl], {
    env: {},
    stdout: "pipe",
    stderr: "pipe",
  });
  const output = new Response(child.stdout).text();
  const diagnostics = new Response(child.stderr).text();
  const exitCode = await exitWithin(child, INSPECTION_DEADLINE_MS);
  if (exitCode === null) {
    // A JS timeout in the inspection isolate cannot interrupt a blocking Proxy
    // trap. Stop the OS child and confirm it exited before reporting refusal.
    child.kill("SIGKILL");
    if ((await exitWithin(child, TERMINATION_DEADLINE_MS)) === null) {
      throw new Error(`inspection child ${id} could not be proved terminated`);
    }
    const message = await output;
    await diagnostics;
    const expectedTrace =
      `${JSON.stringify({ id, phase: "started" })}\n` +
      `${JSON.stringify({ id, phase: "inspecting" })}\n`;
    if (message !== expectedTrace) {
      throw new Error(`inspection child ${id} timed out before reaching inspection`);
    }
    return "timeout-refusal";
  }
  const message = await output;
  await diagnostics;
  if (exitCode !== 0) throw new Error(`inspection child ${id} exited ${exitCode}`);
  const lines = message.trimEnd().split("\n");
  if (
    lines.length !== 3 ||
    lines[0] !== JSON.stringify({ id, phase: "started" }) ||
    lines[1] !== JSON.stringify({ id, phase: "inspecting" })
  ) {
    throw new Error(`inspection child ${id} did not reach inspection and return one verdict`);
  }
  const result = JSON.parse(lines[2] ?? "") as { id?: unknown; verdict?: unknown };
  if (result.id !== id || !["admit", "refuse", "unexpected"].includes(String(result.verdict))) {
    throw new Error(`inspection child ${id} did not return a complete verdict`);
  }
  return result.verdict as ChildVerdict;
}

async function childMain(id: string | undefined, bundleDataUrl: string | undefined): Promise<void> {
  if (!id || !bundleDataUrl?.startsWith("data:text/javascript;base64,")) {
    throw new Error("invalid inspection child input");
  }
  process.stdout.write(`${JSON.stringify({ id, phase: "started" })}\n`);
  let verdict: ChildVerdict = "unexpected";
  let stage: "factory" | "inspection" = "factory";
  try {
    const bundle = await import(bundleDataUrl);
    let namespace: unknown;
    let exportName: string;
    switch (id) {
      case "ordinary-actor-five-handlers":
        namespace = bundle;
        exportName = "OrdinaryActor";
        break;
      case "finite-deep-inherited-five-handlers":
        namespace = bundle;
        exportName = "DeepInheritedActor";
        break;
      case "cyclic-proxy-prototype":
        namespace = bundle.cyclicProxyActorModule();
        exportName = "Actor";
        break;
      case "changing-proxy-prototype":
        namespace = bundle.changingProxyActorModule();
        exportName = "Actor";
        break;
      case "nonreturning-proxy-prototype":
        namespace = bundle.nonReturningProxyActorModule();
        exportName = "Actor";
        break;
      default:
        throw new Error("unknown selected Actor case");
    }
    stage = "inspection";
    process.stdout.write(`${JSON.stringify({ id, phase: "inspecting" })}\n`);
    const inspection = inspectActorClassV2Candidate(namespace, exportName);
    const required = ["fetch", "alarm", "socketMessage", "socketClose", "socketError"] as const;
    if (
      Object.isFrozen(inspection) &&
      Object.isFrozen(inspection.handlers) &&
      required.every((name) => typeof inspection.handlers[name] === "function") &&
      (id !== "finite-deep-inherited-five-handlers" || inspection.handlers.start === undefined)
    ) {
      verdict = "admit";
    }
  } catch (error) {
    if (
      stage === "inspection" &&
      error instanceof Error &&
      "code" in error &&
      error.code === "backend_unavailable"
    ) {
      verdict = "refuse";
    }
  }
  process.stdout.write(JSON.stringify({ id, verdict }));
}

async function parentMain(args: string[]): Promise<void> {
  if (args.length !== 2 || args[0] !== "--corpus-root" || !isAbsolute(args[1] ?? "")) {
    throw new Error(
      "usage: qualify-actor-class-candidate.ts --corpus-root <absolute publisher repo>",
    );
  }
  const root = args[1] as string;
  const manifest = pinnedBlob(root, "manifest.json");
  const bundle = pinnedBlob(root, "bundle.mjs");
  const cases = pinnedBlob(root, "cases.json");
  requireDigest(manifest, MANIFEST_SHA256, "manifest");
  requireDigest(bundle, BUNDLE_SHA256, "bundle");
  requireDigest(cases, CASES_SHA256, "cases");
  parseSelectedCorpus(manifest, cases);

  const bundleDataUrl = `data:text/javascript;base64,${Buffer.from(bundle).toString("base64")}`;
  for (const entry of ACTOR_CASES) {
    const verdict = await inspectInChild(entry.id, bundleDataUrl);
    if (verdict !== entry.expected) {
      throw new Error(`Actor ${entry.id}: expected ${entry.expected}, received ${verdict}`);
    }
    process.stdout.write(`${entry.id}: ${verdict}\n`);
  }
  process.stdout.write(
    `Actor static inspection 5/5 at ${SOURCE_COMMIT}; execution, Workflow and Host admission NOT QUALIFIED\n`,
  );
}

const args = process.argv.slice(2);
if (args[0] === "--child") {
  await childMain(args[1], args[2]);
} else {
  await parentMain(args);
}
