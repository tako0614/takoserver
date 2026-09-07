import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import {
  semanticInspectionPreludeSource,
  semanticInspectionTestWrapperSource,
  snapshotWorkerModuleInspectionInput,
  WORKER_MODULE_AUXILIARY_MEDIA_TYPES,
  WORKER_MODULE_HANDLER_NAMES,
  WORKER_MODULE_IMPORTABLE_MEDIA_TYPES,
  type WorkerModuleHandlerName,
  type WorkerModuleInspectionInput,
  type WorkerModuleInspectionModule,
  type WorkerModuleInspectionResult,
  type WorkerModuleSemanticInspector,
} from "./providers/worker-module-semantic-inspection.ts";
import { TAKOFORM_MAXIMUM_WORKER_BUNDLE_BYTES } from "./takoform/limits.ts";
import { findWorkerd } from "./workerd-supervisor.ts";

/**
 * Semantic worker.runtime inspection in a disposable workerd process.
 *
 * The parent process only snapshots bytes, renders configuration, and decodes
 * an authenticated fixed-vocabulary report. Tenant JavaScript is never
 * imported or evaluated in the Host/control process.
 */

const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const MAXIMUM_IMPORTABLE_MODULES = 512;
const MAXIMUM_AUXILIARY_MODULES = 512;
const DEFAULT_WALL_TIMEOUT_MS = 2_000;
const DEFAULT_OUTPUT_LIMIT_BYTES = 64 * 1_024;
const CHILD_EXIT_GRACE_MS = 1_000;
const SERVICE_NAME = "inspection";
export const WORKERD_INSPECTION_ENTRYPOINT_MODULE =
  "__takoserver-inspection-entrypoint.mjs" as const;
const WORKERD_INSPECTION_PRELUDE_MODULE = "__takoserver-inspection-prelude.mjs" as const;
const WORKERD_INSPECTION_ALTERNATE_PRELUDE_MODULE =
  "__takoserver-inspection-prelude-alternate.mjs" as const;
const textDecoder = new TextDecoder();
const strictUtf8Decoder = new TextDecoder("utf-8", { fatal: true });

export interface WorkerdWorkerModuleInspectorOptions {
  /** Package root used to locate the pinned workerd dependency. */
  readonly repositoryRoot?: string;
  /** Explicit absolute binary path; null makes runtime absence deterministic. */
  readonly binary?: string | null;
  /** Hard wall bound for one fresh child, including module evaluation. */
  readonly wallTimeoutMs?: number;
  /** Per-stream stdout/stderr cap; tenant console output counts toward the bound. */
  readonly outputLimitBytes?: number;
  /** Private parent for one-shot evaluators; the serving runtime uses its data root. */
  readonly temporaryRoot?: string;
}

export function createWorkerdWorkerModuleInspector(
  options: WorkerdWorkerModuleInspectorOptions = {},
): WorkerModuleSemanticInspector {
  const repositoryRoot = resolve(options.repositoryRoot ?? resolve(import.meta.dir, ".."));
  const configuredBinary =
    options.binary === undefined ? findWorkerd(repositoryRoot) : options.binary;
  const binary =
    configuredBinary !== null && isAbsolute(configuredBinary) ? configuredBinary : null;
  const wallTimeoutMs = boundedInteger(
    options.wallTimeoutMs ?? DEFAULT_WALL_TIMEOUT_MS,
    25,
    30_000,
    "wall timeout",
  );
  const outputLimitBytes = boundedInteger(
    options.outputLimitBytes ?? DEFAULT_OUTPUT_LIMIT_BYTES,
    1_024,
    1_048_576,
    "output limit",
  );

  return {
    // Keep this method non-async: the byte copies happen before inspect()
    // returns control to a caller that may still own and mutate its buffers.
    inspect(input) {
      let snapshot: WorkerModuleInspectionInput;
      try {
        snapshot = snapshotWorkerModuleInspectionInput(input);
      } catch {
        return Promise.resolve(unavailable());
      }
      return inspectSnapshot({
        binary,
        snapshot,
        wallTimeoutMs,
        outputLimitBytes,
        ...(options.temporaryRoot === undefined ? {} : { temporaryRoot: options.temporaryRoot }),
      });
    },
  };
}

interface AdmittedSnapshot {
  readonly mainModule: string;
  readonly modules: readonly WorkerModuleInspectionModule[];
  readonly importableModules: readonly WorkerModuleInspectionModule[];
  readonly auxiliaryNames: ReadonlySet<string>;
  readonly declaredHandlers: readonly WorkerModuleHandlerName[];
}

async function inspectSnapshot(input: {
  readonly binary: string | null;
  readonly snapshot: WorkerModuleInspectionInput;
  readonly wallTimeoutMs: number;
  readonly outputLimitBytes: number;
  readonly temporaryRoot?: string;
}): Promise<WorkerModuleInspectionResult> {
  const admitted = admitSnapshot(input.snapshot);
  if ("outcome" in admitted) return admitted;
  if (input.binary === null) return unavailable();

  let root: string;
  try {
    const temporaryRoot = input.temporaryRoot ?? tmpdir();
    await mkdir(temporaryRoot, { recursive: true, mode: 0o700 });
    await chmod(temporaryRoot, 0o700);
    root = await mkdtemp(join(temporaryRoot, "takoserver-worker-inspection-"));
    await chmod(root, 0o700);
  } catch {
    return unavailable();
  }

  let childExited = true;
  let result: WorkerModuleInspectionResult = unavailable();
  try {
    const generated = generatedNames(admitted.mainModule);
    // Keep report authentication independent of generated module names. A
    // tenant getter can observe its caller filenames in Error().stack, and a
    // serving adapter may need to expose a generated module name in its own
    // import graph. Neither observation may reveal this one-shot channel.
    const reportNonce = `${randomBytes(32).toString("base64url")}:`;
    const preludeSource = semanticInspectionPreludeSource({
      startupReportNonce: reportNonce,
    });
    const wrapperSource = semanticInspectionTestWrapperSource({
      preludeModuleSpecifier: `./${generated.preludeName}`,
      tenantModuleSpecifier: `./${admitted.mainModule}`,
      declaredHandlers: admitted.declaredHandlers,
      reportNonce,
    });
    await writeInspection(
      root,
      generated,
      admitted.mainModule,
      admitted.importableModules,
      preludeSource,
      wrapperSource,
    );

    const execution = await runWorkerd({
      binary: input.binary,
      root,
      wallTimeoutMs: input.wallTimeoutMs,
      outputLimitBytes: input.outputLimitBytes,
    });
    childExited = execution.childExited;
    result = classifyExecution(execution, reportNonce, admitted, generated);
  } catch {
    result = unavailable();
  } finally {
    if (childExited) {
      try {
        await rm(root, { recursive: true, force: true });
      } catch {
        result = unavailable();
      }
    } else {
      // Do not remove files from under a child whose death was not observed.
      // The private directory is safer retained than raced with an evaluator.
      result = unavailable();
    }
  }
  return result;
}

function admitSnapshot(
  input: WorkerModuleInspectionInput,
): AdmittedSnapshot | WorkerModuleInspectionResult {
  if (!usableModuleName(input.mainModule)) return invalid("module_not_found");
  if (!Array.isArray(input.modules) || input.modules.length === 0) {
    return invalid("module_not_found");
  }
  if (!Array.isArray(input.declaredHandlers) || input.declaredHandlers.length > 3) {
    return invalid("handler_not_exported");
  }

  const declaredHandlers: WorkerModuleHandlerName[] = [];
  const declared = new Set<string>();
  for (const candidate of input.declaredHandlers as readonly unknown[]) {
    if (
      typeof candidate !== "string" ||
      !(WORKER_MODULE_HANDLER_NAMES as readonly string[]).includes(candidate) ||
      declared.has(candidate)
    ) {
      return invalid("handler_not_exported");
    }
    declared.add(candidate);
    declaredHandlers.push(candidate as WorkerModuleHandlerName);
  }

  const names = new Set<string>();
  const auxiliaryNames = new Set<string>();
  const importableModules: WorkerModuleInspectionModule[] = [];
  let auxiliaryCount = 0;
  let totalBytes = 0;
  for (const entry of input.modules) {
    if (!usableModuleName(entry.name) || names.has(entry.name)) return unavailable();
    names.add(entry.name);
    if (!DIGEST.test(entry.digest) || !(entry.bytes instanceof Uint8Array)) return unavailable();
    totalBytes += entry.bytes.byteLength;
    if (!Number.isSafeInteger(totalBytes) || totalBytes > TAKOFORM_MAXIMUM_WORKER_BUNDLE_BYTES) {
      return unavailable();
    }
    const actual = createHash("sha256").update(entry.bytes).digest("hex");
    if (entry.digest !== `sha256:${actual}`) return unavailable();

    if ((WORKER_MODULE_AUXILIARY_MEDIA_TYPES as readonly string[]).includes(entry.mediaType)) {
      auxiliaryCount += 1;
      auxiliaryNames.add(entry.name);
      continue;
    }
    if (!(WORKER_MODULE_IMPORTABLE_MEDIA_TYPES as readonly string[]).includes(entry.mediaType)) {
      return invalid("unsupported_media_type");
    }
    if (entry.mediaType === "application/javascript+module" || entry.mediaType === "text/plain") {
      try {
        strictUtf8Decoder.decode(entry.bytes);
      } catch {
        return invalid("module_syntax_error");
      }
    }
    importableModules.push(entry);
  }
  if (
    importableModules.length > MAXIMUM_IMPORTABLE_MODULES ||
    auxiliaryCount > MAXIMUM_AUXILIARY_MODULES
  ) {
    return unavailable();
  }

  const main = input.modules.find((entry) => entry.name === input.mainModule);
  if (!main) return invalid("module_not_found");
  if (main.mediaType !== "application/javascript+module") {
    return invalid("unsupported_media_type");
  }
  return {
    mainModule: input.mainModule,
    modules: input.modules,
    importableModules,
    auxiliaryNames,
    declaredHandlers,
  };
}

interface GeneratedNames {
  readonly preludeName: string;
  readonly wrapperName: string;
}

function generatedNames(mainModule: string): GeneratedNames {
  return {
    wrapperName: WORKERD_INSPECTION_ENTRYPOINT_MODULE,
    // HOST_PRIVATE imports the exact application main before its own namespace.
    // Pick the alternate only for that one identity; no application name is
    // rejected or reserved, and either prelude may coexist with an identically
    // named non-main application module.
    preludeName:
      mainModule === WORKERD_INSPECTION_PRELUDE_MODULE
        ? WORKERD_INSPECTION_ALTERNATE_PRELUDE_MODULE
        : WORKERD_INSPECTION_PRELUDE_MODULE,
  };
}

async function writeInspection(
  root: string,
  generated: GeneratedNames,
  applicationMain: string,
  modules: readonly WorkerModuleInspectionModule[],
  preludeSource: string,
  wrapperSource: string,
): Promise<void> {
  const entries: string[] = [];
  const hostRoot = join(root, "host-private");
  const applicationRoot = join(root, "application");
  await mkdir(hostRoot, { recursive: true, mode: 0o700 });
  await mkdir(applicationRoot, { recursive: true, mode: 0o700 });
  const wrapperFile = "entrypoint.mjs";
  const preludeFile = "prelude.mjs";
  await writeFile(join(hostRoot, wrapperFile), wrapperSource, { encoding: "utf8", mode: 0o600 });
  await writeFile(join(hostRoot, preludeFile), preludeSource, { encoding: "utf8", mode: 0o600 });
  entries.push(
    moduleEntry(generated.wrapperName, "esModule", `host-private/${wrapperFile}`, "hostPrivate"),
  );
  entries.push(
    moduleEntry(generated.preludeName, "esModule", `host-private/${preludeFile}`, "hostPrivate"),
  );

  for (let index = 0; index < modules.length; index += 1) {
    const declaration = modules[index];
    if (!declaration) throw new Error("worker module snapshot changed");
    const file = `module-${index.toString().padStart(4, "0")}.bin`;
    await writeFile(join(applicationRoot, file), declaration.bytes, { mode: 0o600 });
    entries.push(
      moduleEntry(
        declaration.name,
        workerdModuleKind(declaration.mediaType),
        `application/${file}`,
        "application",
      ),
    );
  }

  const config = `using Workerd = import "/workerd/workerd.capnp";

const config :Workerd.Config = (
  services = [
    (
      name = ${capnpText(SERVICE_NAME)},
      worker = (
        modules = [
          ${entries.join(",\n          ")},
        ],
        compatibilityDate = "2026-01-01",
        compatibilityFlags = ["disallow_importable_env"],
        globalOutbound = "inspection-deny",
        modulePolicy = (applicationMain = ${capnpText(applicationMain)}),
      ),
    ),
    (name = "inspection-deny", network = (allow = [])),
  ],
  sockets = [],
);
`;
  await writeFile(join(root, "workerd.capnp"), config, { encoding: "utf8", mode: 0o600 });
}

function moduleEntry(
  name: string,
  kind: WorkerdModuleKind,
  file: string,
  role: "application" | "hostPrivate",
): string {
  return `(name = ${capnpText(name)}, ${kind} = embed ${capnpText(file)}, role = ${role})`;
}

type WorkerdModuleKind = "esModule" | "text" | "data" | "wasm";

function workerdModuleKind(mediaType: string): WorkerdModuleKind {
  switch (mediaType) {
    case "application/javascript+module":
      return "esModule";
    case "text/plain":
      return "text";
    case "application/octet-stream":
      return "data";
    case "application/wasm":
      return "wasm";
    default:
      throw new Error("unsupported worker module media type");
  }
}

interface WorkerdExecution {
  readonly exitCode: number | null;
  readonly childExited: boolean;
  readonly timedOut: boolean;
  readonly outputExceeded: boolean;
  readonly stdout: string;
  readonly stderr: string;
}

interface InspectionChild {
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly exited: Promise<number>;
  kill(exitCode?: number): void;
}

async function runWorkerd(input: {
  readonly binary: string;
  readonly root: string;
  readonly wallTimeoutMs: number;
  readonly outputLimitBytes: number;
}): Promise<WorkerdExecution> {
  let child: InspectionChild;
  try {
    child = Bun.spawn({
      cmd: [input.binary, "test", "--no-verbose", join(input.root, "workerd.capnp"), SERVICE_NAME],
      cwd: input.root,
      env: {},
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    }) as InspectionChild;
  } catch {
    return {
      exitCode: null,
      childExited: true,
      timedOut: false,
      outputExceeded: false,
      stdout: "",
      stderr: "",
    };
  }

  try {
    return await runSpawnedWorkerd(child, input);
  } catch {
    hardKill(child);
    const exitCode = await boundedExit(child.exited, CHILD_EXIT_GRACE_MS);
    return {
      exitCode,
      childExited: exitCode !== null,
      timedOut: false,
      outputExceeded: false,
      stdout: "",
      stderr: "",
    };
  }
}

async function runSpawnedWorkerd(
  child: InspectionChild,
  input: {
    readonly wallTimeoutMs: number;
    readonly outputLimitBytes: number;
  },
): Promise<WorkerdExecution> {
  let outputExceeded = false;
  const stopForOutput = () => {
    outputExceeded = true;
    hardKill(child);
  };
  const stdoutPromise = readBounded(child.stdout, input.outputLimitBytes, stopForOutput);
  const stderrPromise = readBounded(child.stderr, input.outputLimitBytes, stopForOutput);

  let timeout: ReturnType<typeof setTimeout> | undefined;
  const raced = await Promise.race([
    child.exited.then((exitCode) => ({ kind: "exit" as const, exitCode })),
    new Promise<{ readonly kind: "timeout" }>((done) => {
      timeout = setTimeout(() => done({ kind: "timeout" }), input.wallTimeoutMs);
    }),
  ]);
  if (timeout !== undefined) clearTimeout(timeout);

  const timedOut = raced.kind === "timeout";
  if (timedOut) hardKill(child);
  const exitCode =
    raced.kind === "exit" ? raced.exitCode : await boundedExit(child.exited, CHILD_EXIT_GRACE_MS);
  const childExited = exitCode !== null;
  if (!childExited) hardKill(child);

  if (!childExited) {
    return {
      exitCode: null,
      childExited: false,
      timedOut,
      outputExceeded,
      stdout: "",
      stderr: "",
    };
  }
  const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
  return {
    exitCode,
    childExited: true,
    timedOut,
    outputExceeded,
    stdout: textDecoder.decode(stdout),
    stderr: textDecoder.decode(stderr),
  };
}

async function readBounded(
  stream: ReadableStream<Uint8Array>,
  limit: number,
  onExceeded: () => void,
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      const remaining = limit - size;
      if (next.value.byteLength > remaining) {
        if (remaining > 0) {
          chunks.push(next.value.slice(0, remaining));
          size += remaining;
        }
        onExceeded();
        break;
      }
      chunks.push(next.value);
      size += next.value.byteLength;
    }
  } catch {
    onExceeded();
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // The child is already being terminated; no tenant diagnostic is useful.
    }
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function classifyExecution(
  execution: WorkerdExecution,
  nonce: string,
  admitted: AdmittedSnapshot,
  generated: GeneratedNames,
): WorkerModuleInspectionResult {
  if (!execution.childExited || execution.exitCode === null) return unavailable();
  const reports = inspectionReports(execution.stdout, nonce);
  // The prelude emits this before the tenant is evaluated. Once it is the
  // first authenticated record, extra or malformed records are deterministic
  // tenant interference, not evidence that the runtime was unavailable.
  const started = reports[0] === "start";
  if (execution.timedOut || execution.outputExceeded) {
    return started ? invalid("module_evaluation_limit_exceeded") : unavailable();
  }

  if (execution.exitCode !== 0) {
    const missing = classifyMissingModuleFailure(execution.stderr, admitted, generated);
    if (missing !== null) return missing;
    if (started) {
      return execution.exitCode === 1 && /^service inspection: Uncaught /u.test(execution.stderr)
        ? invalid("module_evaluation_failed")
        : unavailable();
    }
    return classifyPreEvaluationFailure(execution.stderr, admitted, generated);
  }
  if (!started) return unavailable();
  if (reports.length !== 2) return invalid("module_evaluation_failed");
  const report = reports[1];
  if (report === undefined) return invalid("module_evaluation_failed");
  if (report === "invalid:handler_not_exported") return invalid("handler_not_exported");
  if (report === "invalid:module_evaluation_failed") {
    return invalid("module_evaluation_failed");
  }
  const match = /^valid:([0-7])$/u.exec(report);
  if (!match) return invalid("module_evaluation_failed");
  const mask = Number(match[1]);
  const exportedHandlers = WORKER_MODULE_HANDLER_NAMES.filter(
    (_handler, index) => (mask & (1 << index)) !== 0,
  );
  return { outcome: "valid", exportedHandlers };
}

function inspectionReports(stdout: string, nonce: string): readonly string[] {
  const reports: string[] = [];
  for (const line of stdout.split(/\r?\n/u)) {
    if (line.startsWith(nonce)) reports.push(line.slice(nonce.length));
  }
  return reports;
}

function classifyPreEvaluationFailure(
  stderr: string,
  admitted: AdmittedSnapshot,
  generated: GeneratedNames,
): WorkerModuleInspectionResult {
  const syntaxModule = diagnosticModule(stderr);
  if (
    syntaxModule !== null &&
    (syntaxModule === "<tenant-wasm>" ||
      (syntaxModule !== generated.wrapperName &&
        syntaxModule !== generated.preludeName &&
        admitted.importableModules.some((entry) => entry.name === syntaxModule)))
  ) {
    return invalid("module_syntax_error");
  }
  return unavailable();
}

function classifyMissingModuleFailure(
  stderr: string,
  admitted: AdmittedSnapshot,
  generated: GeneratedNames,
): WorkerModuleInspectionResult | null {
  const header = /^service inspection: Uncaught Error: No such module "([^"\r\n]+)"\.\r?\n/u.exec(
    stderr,
  );
  const name = header?.[1];
  if (name === undefined) return null;

  const importer =
    /(?:^|\r?\n) {2}imported from "([^"\r\n]+)"(?:\r?\n|$)/u.exec(stderr)?.[1] ??
    /(?:^|\r?\n) {2}at (?:async )?(.+?):\d+:\d+(?:\r?\n|$)/u.exec(stderr)?.[1];
  // A failure in the two Host-private bootstrap edges is a broken adapter or
  // incompatible binary. Every other missing lookup is application-owned;
  // eval-created scripts with no recoverable frame intentionally default to
  // application provenance in the closed-graph runtime.
  if (
    importer === generated.wrapperName &&
    (name === generated.preludeName || name === admitted.mainModule)
  ) {
    return unavailable();
  }
  return admitted.auxiliaryNames.has(name)
    ? invalid("unsupported_media_type")
    : invalid("module_not_found");
}

function diagnosticModule(stderr: string): string | null {
  if (
    /^service inspection: Uncaught CompileError: WasmModuleObject::Compile\(\):[^\r\n]*\r?\n?$/u.test(
      stderr,
    )
  ) {
    // Only tenant-declared modules are rendered as Wasm. This diagnostic is
    // produced during compilation, before the prelude's startup marker or any
    // tenant evaluation can run.
    return "<tenant-wasm>";
  }
  if (!/^service inspection: Uncaught (?:SyntaxError|CompileError):/u.test(stderr)) return null;
  const location = /\n {2}at ([^:\r\n]+)(?::\d+)?(?::\d+)?\r?\n?$/u.exec(stderr);
  return location?.[1] ?? null;
}

function hardKill(child: InspectionChild): void {
  try {
    child.kill(9);
  } catch {
    // The exit promise below is the authority on whether cleanup is safe.
  }
}

async function boundedExit(exit: Promise<number>, milliseconds: number): Promise<number | null> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const result = await Promise.race([
    exit.then((code) => ({ done: true as const, code })),
    new Promise<{ readonly done: false }>((done) => {
      timeout = setTimeout(() => done({ done: false }), milliseconds);
    }),
  ]);
  if (timeout !== undefined) clearTimeout(timeout);
  return result.done ? result.code : null;
}

function invalid(
  error: Extract<WorkerModuleInspectionResult, { outcome: "invalid" }>["error"],
): WorkerModuleInspectionResult {
  return { outcome: "invalid", error };
}

function unavailable(): WorkerModuleInspectionResult {
  return { outcome: "unavailable", retryable: true };
}

function usableModuleName(value: string): boolean {
  if (typeof value !== "string" || value.length === 0 || value.length > 1_024) return false;
  // Module names are runtime identities, not filesystem paths. In particular,
  // builtin-looking names remain valid application declarations. Physical
  // files use ordinal names, so only values Cap'n Proto cannot represent are
  // refused here.
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code === 0 || (code >= 0xd800 && code <= 0xdfff)) return false;
  }
  return true;
}

function boundedInteger(value: number, minimum: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`worker module inspection ${label} is invalid`);
  }
  return value;
}

/** Escape a workerd Cap'n Proto Text literal without admitting configuration syntax. */
function capnpText(value: string): string {
  let output = '"';
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code === 0 || (code >= 0xd800 && code <= 0xdfff)) {
      throw new TypeError("worker module name is not representable by workerd");
    }
    switch (character) {
      case '"':
        output += '\\"';
        continue;
      case "\\":
        output += "\\\\";
        continue;
      case "\n":
        output += "\\n";
        continue;
      case "\r":
        output += "\\r";
        continue;
      case "\t":
        output += "\\t";
        continue;
      case "\b":
        output += "\\b";
        continue;
      case "\f":
        output += "\\f";
        continue;
      case "\v":
        output += "\\v";
        continue;
      default:
        break;
    }
    if (code < 0x20 || code === 0x7f) {
      output += `\\x${code.toString(16).padStart(2, "0")}`;
      continue;
    }
    output += character;
  }
  return `${output}"`;
}
