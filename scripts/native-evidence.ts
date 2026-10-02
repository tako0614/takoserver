/**
 * Native evidence that the portable gate cannot supply by itself.
 *
 * Tests in `tests/` exercise four optional native capabilities: the pinned
 * closed-graph `workerd` build, an unqualified Actor qualification candidate,
 * an opt-in local Docker container lifecycle fixture, and a separate
 * Host-process Docker lifecycle fixture. The two binary-backed capabilities
 * gate on operator-supplied paths; both Docker capabilities gate on their
 * explicit opt-in and bounded fixture configuration.
 *
 * That choice is correct — `selectClosedGraphWorkerd` refuses to substitute a
 * package binary for the pinned bytes — but it used to be invisible. This module
 * names the capabilities that gate tests and reports what a run did not prove.
 * The Docker configuration inspection is deliberately bounded and performs no
 * daemon or image I/O; only the later opted-in test exercises that local runtime.
 *
 * Two rules keep the report honest:
 *
 * - An *unconfigured* capability is not a failure. The portable gate must stay
 *   green on a machine that has no native artifact.
 * - A *configured* capability that does not hold is a failure. Claiming the
 *   capability must never silently degrade back into skips.
 */

import { createHash } from "node:crypto";
import {
  accessSync,
  type Dirent,
  constants as fsConstants,
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { isAbsolute, join, relative } from "node:path";

import { WORKERD_CLOSED_GRAPH_ARTIFACT } from "../src/workerd-artifact.ts";

export type NativeEvidenceState = "unconfigured" | "invalid" | "ready";

export interface NativeEvidenceStatus {
  readonly state: NativeEvidenceState;
  /** One line explaining the state, quoted verbatim in the report. */
  readonly detail: string;
  /** Ready means only that bounded inputs are valid, not that a gated test ran. */
  readonly readinessOnly?: boolean;
}

/** Side-effect-free host probes, injected so the rules stay testable. */
export interface NativeEvidenceProbe {
  isExecutableFile(path: string): boolean;
  sha256(path: string): string | null;
}

export interface NativeEvidenceCapability {
  readonly id: string;
  readonly label: string;
  /** Environment variable whose presence turns the gated tests on. */
  readonly environment: string;
  /** Further variables the same gated tests need once they run. */
  readonly companionEnvironment: readonly string[];
  /** What the gated tests would prove if they ran. */
  readonly proves: string;
  /** What an operator has to supply. */
  readonly enable: string;
  readonly inspect: (
    configured: string | undefined,
    environment: Readonly<Record<string, string | undefined>>,
    probe: NativeEvidenceProbe,
  ) => NativeEvidenceStatus;
}

const DIGEST = /^[a-f0-9]{64}$/u;
const DOCKER_LIFECYCLE_FIXTURE_ENVIRONMENT = [
  "TAKOSERVER_NATIVE_CONTAINER_IMAGE_A",
  "TAKOSERVER_NATIVE_CONTAINER_IMAGE_B",
  "TAKOSERVER_NATIVE_CONTAINER_PROVENANCE_LABEL_A",
  "TAKOSERVER_NATIVE_CONTAINER_PROVENANCE_LABEL_B",
  "TAKOSERVER_NATIVE_CONTAINER_PROVENANCE_VALUE_A",
  "TAKOSERVER_NATIVE_CONTAINER_PROVENANCE_VALUE_B",
  "TAKOSERVER_NATIVE_CONTAINER_VERSION_A",
  "TAKOSERVER_NATIVE_CONTAINER_VERSION_B",
  "TAKOSERVER_NATIVE_CONTAINER_SERVER_A",
  "TAKOSERVER_NATIVE_CONTAINER_SERVER_B",
  "TAKOSERVER_NATIVE_CONTAINER_PORT",
] as const;

function missingOrUnusable(
  binary: string,
  probe: NativeEvidenceProbe,
): NativeEvidenceStatus | null {
  if (!isAbsolute(binary)) {
    return { state: "invalid", detail: "the configured path is not absolute" };
  }
  if (!probe.isExecutableFile(binary)) {
    return { state: "invalid", detail: "the configured path is not a readable executable file" };
  }
  return null;
}

export const NATIVE_EVIDENCE_CAPABILITIES: readonly NativeEvidenceCapability[] = [
  {
    id: "workerd-artifact",
    label: "pinned closed-graph workerd artifact",
    environment: "TAKOSERVER_WORKERD_BINARY",
    companionEnvironment: ["TAKOSERVER_WORKFLOW_EXECUTION_GUARD_BINARY"],
    proves:
      "native Durable Object SQL, alarm and WebSocket persistence, Actor facets and sockets, module inspection, and Workflow execution against the exact pinned bytes",
    enable: `${"TAKOSERVER_WORKERD_BINARY"}=/absolute/path/to/pinned/workerd`,
    inspect: (configured, _environment, probe) => {
      if (configured === undefined || configured.trim() === "") {
        return {
          state: "unconfigured",
          detail: "TAKOSERVER_WORKERD_BINARY is not configured; Worker execution is disabled",
        };
      }
      const unusable = missingOrUnusable(configured, probe);
      if (unusable) return unusable;
      if (
        process.platform !== WORKERD_CLOSED_GRAPH_ARTIFACT.platform ||
        process.arch !== WORKERD_CLOSED_GRAPH_ARTIFACT.arch
      ) {
        return {
          state: "invalid",
          detail: `the pinned artifact supports ${WORKERD_CLOSED_GRAPH_ARTIFACT.platform}/${WORKERD_CLOSED_GRAPH_ARTIFACT.arch}, this host is ${process.platform}/${process.arch}`,
        };
      }
      const digest = probe.sha256(configured);
      if (digest === null) {
        return { state: "invalid", detail: "the configured path could not be hashed" };
      }
      if (digest !== WORKERD_CLOSED_GRAPH_ARTIFACT.sha256) {
        return {
          state: "invalid",
          detail: `the configured bytes are ${digest}; the pinned artifact is ${WORKERD_CLOSED_GRAPH_ARTIFACT.sha256}`,
        };
      }
      return { state: "ready", detail: `configured and verified as ${digest}` };
    },
  },
  {
    id: "actor-qualification",
    label: "unqualified Actor qualification candidate",
    environment: "TAKOSERVER_ACTOR_QUALIFICATION_BINARY",
    companionEnvironment: ["TAKOSERVER_ACTOR_QUALIFICATION_SHA256"],
    proves:
      "candidate native Actor class execution, class inspection, socket bridging, upgrade response and opaque handoff — candidate evidence, never a published contract",
    enable: `${"TAKOSERVER_ACTOR_QUALIFICATION_BINARY"}=/absolute/path/to/candidate ${"TAKOSERVER_ACTOR_QUALIFICATION_SHA256"}=<64 hex>`,
    inspect: (configured, environment, probe) => {
      if (configured === undefined || configured.trim() === "") {
        return {
          state: "unconfigured",
          detail:
            "TAKOSERVER_ACTOR_QUALIFICATION_BINARY is not configured; candidate Actor evidence is disabled",
        };
      }
      const unusable = missingOrUnusable(configured, probe);
      if (unusable) return unusable;
      const expected = environment.TAKOSERVER_ACTOR_QUALIFICATION_SHA256;
      if (expected === undefined || !DIGEST.test(expected)) {
        return {
          state: "invalid",
          detail:
            "TAKOSERVER_ACTOR_QUALIFICATION_SHA256 is missing or not a 64-character lowercase hex digest",
        };
      }
      const digest = probe.sha256(configured);
      if (digest === null) {
        return { state: "invalid", detail: "the configured path could not be hashed" };
      }
      if (digest !== expected) {
        return {
          state: "invalid",
          detail: `the configured bytes are ${digest}; TAKOSERVER_ACTOR_QUALIFICATION_SHA256 declares ${expected}`,
        };
      }
      return { state: "ready", detail: `configured and verified as ${digest}` };
    },
  },
  {
    id: "container-host-lifecycle",
    label: "local self-host Container Host process and Docker lifecycle",
    environment: "TAKOSERVER_NATIVE_CONTAINER_HOST_LIFECYCLE",
    companionEnvironment: [
      "TAKOSERVER_NATIVE_CONTAINER_FORM_ARTIFACT",
      "TAKOSERVER_NATIVE_CONTAINER_FORM_ARTIFACT_SHA256",
      "TAKOSERVER_NATIVE_CONTAINER_IMAGE_A",
      "TAKOSERVER_NATIVE_CONTAINER_IMAGE_B",
      "TAKOSERVER_NATIVE_CONTAINER_DOCKER_SOCKET",
      "TAKOSERVER_NATIVE_CONTAINER_NETWORK",
    ],
    proves:
      "the explicitly selected local unpublished ContainerService and exact repository-fixture ContainerEndpoint Forms through public Host CRUD, actual OS-process restart, lost-acknowledgement replay, Docker ownership and lifecycle readback, and loopback TCP 443 TLS/SNI; it does not prove publisher admission, published support, public DNS or certificate trust, or portable HTTP Binding",
    enable:
      "TAKOSERVER_NATIVE_CONTAINER_HOST_LIFECYCLE=1 plus the exact local Service Form artifact path/SHA-256, the frozen repository Endpoint fixture, two distinct immutable image refs, Docker Unix socket path, pre-created owned internal network, and available loopback TCP port 443. The gated test checks both exact RepoDigests are already local, but the runtime still sends Docker /images/create requests that may contact those images' public registry; this does not prove zero registry contact",
    inspect: (configured, environment, probe) => {
      if (configured === undefined || configured.trim() === "") {
        return {
          state: "unconfigured",
          detail:
            "TAKOSERVER_NATIVE_CONTAINER_HOST_LIFECYCLE is not configured; OS-process and Docker lifecycle remain unproven",
        };
      }
      if (configured !== "1") {
        return {
          state: "invalid",
          detail: "TAKOSERVER_NATIVE_CONTAINER_HOST_LIFECYCLE must be exactly 1",
        };
      }
      const artifact = environment.TAKOSERVER_NATIVE_CONTAINER_FORM_ARTIFACT;
      const expected = environment.TAKOSERVER_NATIVE_CONTAINER_FORM_ARTIFACT_SHA256;
      if (artifact === undefined || !isAbsolute(artifact)) {
        return {
          state: "invalid",
          detail: "the local ContainerService Form artifact path must be absolute",
        };
      }
      if (expected !== "7ab6dce1bbbfecc69f5732abd25100db83168c640e8d1054f5a708ad4ef6a0b2") {
        return {
          state: "invalid",
          detail: "the configured local Form artifact SHA-256 is not the reviewed final candidate",
        };
      }
      const actual = probe.sha256(artifact);
      if (actual === null || actual !== expected) {
        return {
          state: "invalid",
          detail: "the configured local Form artifact is unreadable or does not match its SHA-256",
        };
      }
      const imageA = environment.TAKOSERVER_NATIVE_CONTAINER_IMAGE_A;
      const imageB = environment.TAKOSERVER_NATIVE_CONTAINER_IMAGE_B;
      const imageRef =
        /^(?:[a-z0-9]+(?:[.-][a-z0-9]+)*(?::[1-9][0-9]{0,4})?\/)?[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*@sha256:[a-f0-9]{64}$/u;
      if (
        imageA === undefined ||
        imageB === undefined ||
        !imageRef.test(imageA) ||
        !imageRef.test(imageB) ||
        imageA === imageB
      ) {
        return {
          state: "invalid",
          detail: "two distinct immutable OCI image references are required",
        };
      }
      const socket = environment.TAKOSERVER_NATIVE_CONTAINER_DOCKER_SOCKET;
      if (socket === undefined || !isAbsolute(socket) || socket.includes("\0")) {
        return {
          state: "invalid",
          detail: "the Docker Unix socket path must be absolute",
        };
      }
      const network = environment.TAKOSERVER_NATIVE_CONTAINER_NETWORK;
      if (
        network === undefined ||
        !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u.test(network) ||
        ["host", "bridge", "none"].includes(network)
      ) {
        return {
          state: "invalid",
          detail: "a non-reserved pre-created Docker network name is required",
        };
      }
      return {
        state: "ready",
        detail:
          "bounded local Form/image/socket/network inputs are configured; Docker execution and process-restart proof still require running the gated test",
        readinessOnly: true,
      };
    },
  },
  {
    id: "docker-container-lifecycle",
    label: "self-host Docker container lifecycle fixture",
    environment: "TAKOSERVER_NATIVE_CONTAINER_LIFECYCLE",
    companionEnvironment: DOCKER_LIFECYCLE_FIXTURE_ENVIRONMENT,
    proves:
      "local Docker fixture create, invocation, update, fresh-handle recovery, and delete; it does not prove host restart or a public-host/Cloudflare runtime",
    enable:
      "TAKOSERVER_NATIVE_CONTAINER_LIFECYCLE=1 plus both immutable image digests, provenance label/value pairs, versions, server headers, and TAKOSERVER_NATIVE_CONTAINER_PORT",
    inspect: (configured, environment) => {
      if (configured === undefined) {
        return {
          state: "unconfigured",
          detail:
            "TAKOSERVER_NATIVE_CONTAINER_LIFECYCLE is not configured; Docker lifecycle tests are disabled",
        };
      }
      if (configured !== "1") {
        return {
          state: "invalid",
          detail: 'TAKOSERVER_NATIVE_CONTAINER_LIFECYCLE must be exactly "1" when configured',
        };
      }
      const values = new Map<string, string>();
      for (const name of DOCKER_LIFECYCLE_FIXTURE_ENVIRONMENT) {
        const value = environment[name]?.trim();
        if (!value) return { state: "invalid", detail: `${name} is missing or empty` };
        if (value.length > 512)
          return { state: "invalid", detail: `${name} exceeds the 512-character input bound` };
        values.set(name, value);
      }
      const imageA = values.get("TAKOSERVER_NATIVE_CONTAINER_IMAGE_A");
      const imageB = values.get("TAKOSERVER_NATIVE_CONTAINER_IMAGE_B");
      const immutableImage = /^[^\s@]+(?:\/[^\s@]+)*@sha256:[a-f0-9]{64}$/u;
      if (
        imageA === undefined ||
        imageB === undefined ||
        !immutableImage.test(imageA) ||
        !immutableImage.test(imageB) ||
        imageA === imageB
      ) {
        return {
          state: "invalid",
          detail: "fixture images must be distinct immutable repository digest references",
        };
      }
      const port = Number(values.get("TAKOSERVER_NATIVE_CONTAINER_PORT"));
      if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) {
        return {
          state: "invalid",
          detail:
            "TAKOSERVER_NATIVE_CONTAINER_PORT must be an unprivileged TCP port from 1024 through 65535",
        };
      }
      return {
        state: "ready",
        detail: "fixture inputs are valid and bounded; Docker was not contacted or invoked",
        readinessOnly: true,
      };
    },
  },
];

export interface NativeEvidenceGate {
  /** Repository-relative test path. */
  readonly file: string;
  /** Environment variables the gate names, in source order, de-duplicated. */
  readonly environments: readonly string[];
  /** Capability ids the gate names directly, when it does not name an environment. */
  readonly capabilities?: readonly string[];
  /** Capability the gate belongs to, or null when no capability claims it. */
  readonly capability: string | null;
}

const ENVIRONMENT_PREFIX = "process.env.";
const CAPABILITY_CALL = "nativeEvidenceBinary(";

function environmentReferences(text: string): string[] {
  const found: string[] = [];
  let cursor = 0;
  for (;;) {
    const at = text.indexOf(ENVIRONMENT_PREFIX, cursor);
    if (at < 0) break;
    const rest = text.slice(at + ENVIRONMENT_PREFIX.length);
    const match = /^[A-Za-z_][A-Za-z0-9_]*/u.exec(rest);
    if (match) found.push(match[0]);
    cursor = at + ENVIRONMENT_PREFIX.length;
  }
  return found;
}

/** A string literal in a source file, with the offsets of its contents. */
interface SourceLiteral {
  /** Offset of the first content character, in the original source. */
  readonly start: number;
  /** Offset one past the last content character. */
  readonly end: number;
  readonly content: string;
}

/** What one span of code says about the artifacts it needs. */
interface SourceClaims {
  readonly environments: readonly string[];
  readonly capabilities: readonly string[];
}

/**
 * Every string, template and comment literal in a source file.
 *
 * The gate scan has to read code, not the test data embedded in it: a test that
 * builds a fixture module as a template literal, or that asserts on a report
 * string, contains `skipIf(` and `process.env.` text that is not a gate. The
 * offsets let the scan blank those spans while still reading the capability id
 * out of `nativeEvidenceBinary("...")`.
 */
function sourceLiterals(source: string): SourceLiteral[] {
  const literals: SourceLiteral[] = [];
  const end = source.length;

  const scanQuoted = (at: number): number => {
    const quote = source[at];
    const start = at + 1;
    let index = start;
    while (index < end) {
      const character = source[index];
      if (character === "\\") {
        index += 2;
        continue;
      }
      if (character === quote || character === "\n") break;
      index += 1;
    }
    literals.push({ start, end: index, content: source.slice(start, index) });
    return source[index] === quote ? index + 1 : index;
  };

  const scanTemplate = (at: number): number => {
    let index = at + 1;
    let textStart = index;
    while (index < end) {
      const character = source[index];
      if (character === "\\") {
        index += 2;
        continue;
      }
      if (character === "`") {
        literals.push({ start: textStart, end: index, content: source.slice(textStart, index) });
        return index + 1;
      }
      if (character === "$" && source[index + 1] === "{") {
        literals.push({ start: textStart, end: index, content: source.slice(textStart, index) });
        index += 2;
        let depth = 1;
        while (index < end && depth > 0) {
          const inner = source[index];
          if (inner === "{") depth += 1;
          else if (inner === "}") depth -= 1;
          else if (inner === '"' || inner === "'") index = scanQuoted(index) - 1;
          else if (inner === "`") index = scanTemplate(index) - 1;
          else if (inner === "/" && source[index + 1] === "/") {
            while (index < end && source[index] !== "\n") index += 1;
            continue;
          } else if (inner === "/" && source[index + 1] === "*") {
            index += 2;
            while (index < end && !(source[index] === "*" && source[index + 1] === "/")) {
              index += 1;
            }
          }
          index += 1;
        }
        textStart = index;
        continue;
      }
      index += 1;
    }
    literals.push({ start: textStart, end, content: source.slice(textStart, end) });
    return end;
  };

  let index = 0;
  while (index < end) {
    const character = source[index];
    if (character === "/" && source[index + 1] === "/") {
      while (index < end && source[index] !== "\n") index += 1;
      continue;
    }
    if (character === "/" && source[index + 1] === "*") {
      index += 2;
      while (index < end && !(source[index] === "*" && source[index + 1] === "/")) index += 1;
      index += 2;
      continue;
    }
    if (character === '"' || character === "'") {
      index = scanQuoted(index);
      continue;
    }
    if (character === "`") {
      index = scanTemplate(index);
      continue;
    }
    index += 1;
  }
  return literals;
}

/** The source with every literal content blanked, at the same offsets. */
function maskLiterals(source: string, literals: readonly SourceLiteral[]): string {
  const characters = source.split("");
  for (const literal of literals) {
    for (let index = literal.start; index < literal.end; index += 1) {
      if (characters[index] !== "\n") characters[index] = " ";
    }
  }
  return characters.join("");
}

/** Argument spans of every `nativeEvidenceBinary(...)` call, nested parens balanced. */
function capabilityCallArguments(
  masked: string,
  from: number,
  to: number,
): { start: number; end: number }[] {
  const found: { start: number; end: number }[] = [];
  let cursor = from;
  for (;;) {
    const at = masked.indexOf(CAPABILITY_CALL, cursor);
    if (at < 0 || at >= to) break;
    let depth = 0;
    let index = at + CAPABILITY_CALL.length - 1;
    const start = index + 1;
    for (; index < masked.length; index += 1) {
      const character = masked[index];
      if (character === "(") depth += 1;
      else if (character === ")") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    found.push({ start, end: index });
    cursor = index;
  }
  return found;
}

/** Capability ids and environment names named by one span of code. */
function claimsIn(
  masked: string,
  literals: readonly SourceLiteral[],
  start: number,
  end: number,
): SourceClaims {
  const environments: string[] = [];
  const capabilities: string[] = [];
  for (const name of environmentReferences(masked.slice(start, end))) {
    if (!environments.includes(name)) environments.push(name);
  }
  for (const argument of capabilityCallArguments(masked, start, end)) {
    const named = literals
      .filter((literal) => literal.start >= argument.start && literal.end <= argument.end)
      .sort((left, right) => left.start - right.start)
      .map((literal) => literal.content);
    const id = named[0];
    if (id !== undefined && id !== "" && !capabilities.includes(id)) capabilities.push(id);
    const capability = NATIVE_EVIDENCE_CAPABILITIES.find((entry) => entry.id === id);
    if (capability !== undefined && !environments.includes(capability.environment)) {
      environments.push(capability.environment);
    }
    const override = named[1];
    if (override !== undefined && override !== "" && !environments.includes(override)) {
      environments.push(override);
    }
  }
  return { environments, capabilities };
}

/**
 * `const name = <expression>` bindings, so a gate naming `name` resolves.
 *
 * The initializer runs to the first `;` at bracket depth zero, or to the end of
 * the line, so a multi-line `nativeEvidenceBinary(` call resolves as one value.
 */
function environmentAliases(
  masked: string,
  literals: readonly SourceLiteral[],
): ReadonlyMap<string, SourceClaims> {
  const aliases = new Map<string, SourceClaims>();
  for (const match of masked.matchAll(/\bconst\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=/gu)) {
    const name = match[1];
    if (name === undefined) continue;
    const start = match.index + match[0].length;
    let depth = 0;
    let index = start;
    for (; index < masked.length; index += 1) {
      const character = masked[index];
      if (character === "(" || character === "[" || character === "{") depth += 1;
      else if (character === ")" || character === "]" || character === "}") depth -= 1;
      else if (depth === 0 && (character === ";" || character === "\n")) break;
    }
    aliases.set(name, claimsIn(masked, literals, start, index));
  }
  return aliases;
}

/** Argument span of every `skipIf(...)` call, with nested parens balanced. */
function skipIfArguments(masked: string): { start: number; end: number }[] {
  const argumentsFound: { start: number; end: number }[] = [];
  const needle = "skipIf(";
  let cursor = 0;
  for (;;) {
    const at = masked.indexOf(needle, cursor);
    if (at < 0) break;
    let depth = 0;
    let index = at + needle.length - 1;
    const start = index + 1;
    for (; index < masked.length; index += 1) {
      const character = masked[index];
      if (character === "(") depth += 1;
      else if (character === ")") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    argumentsFound.push({ start, end: index });
    cursor = index;
  }
  return argumentsFound;
}

function classify(environments: readonly string[], capabilities: readonly string[]): string | null {
  // Two native suites may require the same immutable image inputs. Shared
  // companions cannot be mapped to one owner; every named environment must
  // belong to the selected capability, and an explicit ID resolves only a
  // still-ambiguous shared-input gate.
  const matches = NATIVE_EVIDENCE_CAPABILITIES.filter(
    (capability) =>
      capabilities.every((id) => id === capability.id) &&
      environments.every(
        (name) => name === capability.environment || capability.companionEnvironment.includes(name),
      ),
  );
  return matches.length === 1 ? (matches[0]?.id ?? null) : null;
}

function testFiles(root: string): string[] {
  const found: string[] = [];
  const walk = (directory: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith(".test.ts")) found.push(path);
    }
  };
  walk(root);
  return found.sort();
}

/** Every `skipIf` gate in the test tree, classified by the capability it needs. */
export function collectNativeEvidenceGates(root: string): readonly NativeEvidenceGate[] {
  const gates: NativeEvidenceGate[] = [];
  for (const file of testFiles(root)) {
    const source = readFileSync(file, "utf8");
    const literals = sourceLiterals(source);
    const masked = maskLiterals(source, literals);
    const aliases = environmentAliases(masked, literals);
    for (const argument of skipIfArguments(masked)) {
      const environments: string[] = [];
      const capabilities: string[] = [];
      const add = (claims: SourceClaims): void => {
        for (const name of claims.environments) {
          if (!environments.includes(name)) environments.push(name);
        }
        for (const id of claims.capabilities) {
          if (!capabilities.includes(id)) capabilities.push(id);
        }
      };
      add(claimsIn(masked, literals, argument.start, argument.end));
      const text = masked.slice(argument.start, argument.end);
      for (const identifier of text.split(/[^A-Za-z0-9_$]+/u)) {
        if (identifier === "") continue;
        const alias = aliases.get(identifier);
        if (alias !== undefined) add(alias);
      }
      gates.push({
        file: relative(root, file),
        environments,
        capabilities,
        capability: classify(environments, capabilities),
      });
    }
  }
  return gates;
}

export interface NativeEvidenceSummary {
  readonly capability: string;
  readonly label: string;
  readonly state: NativeEvidenceState;
  readonly detail: string;
  readonly environment: string;
  readonly proves: string;
  readonly enable: string;
  readonly tests: number;
  readonly files: number;
  readonly readinessOnly: boolean;
}

export function summarizeNativeEvidence(input: {
  readonly gates: readonly NativeEvidenceGate[];
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly probe: NativeEvidenceProbe;
}): readonly NativeEvidenceSummary[] {
  return NATIVE_EVIDENCE_CAPABILITIES.map((capability) => {
    const owned = input.gates.filter((gate) => gate.capability === capability.id);
    const status = capability.inspect(
      input.environment[capability.environment],
      input.environment,
      input.probe,
    );
    return {
      capability: capability.id,
      label: capability.label,
      state: status.state,
      detail: status.detail,
      environment: capability.environment,
      proves: capability.proves,
      enable: capability.enable,
      tests: owned.length,
      files: new Set(owned.map((gate) => gate.file)).size,
      readinessOnly: status.readinessOnly ?? false,
    };
  });
}

export function renderNativeEvidenceReport(input: {
  readonly summaries: readonly NativeEvidenceSummary[];
  readonly gates: readonly NativeEvidenceGate[];
}): readonly string[] {
  const lines: string[] = [];
  const total = input.gates.length;
  const files = new Set(input.gates.map((gate) => gate.file)).size;
  lines.push(`native evidence: ${total} gated tests in ${files} files`);
  for (const summary of input.summaries) {
    lines.push("");
    lines.push(`  ${summary.label} (${summary.environment})`);
    lines.push(`    state: ${summary.state} — ${summary.detail}`);
    if (summary.state === "unconfigured") {
      lines.push(
        `    NOT PROVEN BY THIS RUN: ${summary.tests} tests in ${summary.files} files did not execute`,
      );
    } else if (summary.state === "invalid") {
      lines.push(
        `    REFUSED: ${summary.tests} tests in ${summary.files} files stay unproven, and a configured artifact that does not hold is a gate failure`,
      );
    } else if (summary.readinessOnly) {
      lines.push(
        `    ready for gated tests: ${summary.tests} tests in ${summary.files} files; runtime execution is not proven by this inspection`,
      );
    } else {
      lines.push(
        `    proven by this run: ${summary.tests} tests in ${summary.files} files execute against the verified artifact`,
      );
    }
    lines.push(`    proves: ${summary.proves}`);
    lines.push(`    enable: ${summary.enable}`);
  }
  const unclassified = input.gates.filter((gate) => gate.capability === null);
  if (unclassified.length > 0) {
    lines.push("");
    lines.push(`  unclassified gates: ${unclassified.length}`);
    for (const gate of unclassified) {
      const named = [...gate.environments, ...(gate.capabilities ?? [])];
      lines.push(
        `    ${gate.file} gates on ${named.join(", ") || "<no environment>"}, which no capability claims`,
      );
    }
    lines.push(
      "    a gate no capability claims would be counted as proven by silence; add it to scripts/native-evidence.ts",
    );
  }
  return lines;
}

/** Unconfigured capabilities are not failures; refused or unclassified ones are. */
export function nativeEvidenceExitCode(input: {
  readonly summaries: readonly NativeEvidenceSummary[];
  readonly gates: readonly NativeEvidenceGate[];
}): number {
  const refused = input.summaries.some((summary) => summary.state === "invalid");
  const unclassified = input.gates.some((gate) => gate.capability === null);
  return refused || unclassified ? 1 : 0;
}

/** Real host probes. */
export const hostProbe: NativeEvidenceProbe = {
  isExecutableFile(path) {
    try {
      if (!statSync(path).isFile()) return false;
      accessSync(path, fsConstants.R_OK | fsConstants.X_OK);
      return true;
    } catch {
      return false;
    }
  },
  sha256(path) {
    try {
      return createHash("sha256").update(readFileSync(path)).digest("hex");
    } catch {
      return null;
    }
  },
};
