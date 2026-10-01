import { createHash } from "node:crypto";
import { applicationSchemaMatches } from "./application-schema-shape.ts";
import { mutationError, preflightError } from "./errors.ts";
import type { D1SchemaState } from "./migrations.ts";
import {
  type Protected0058AttemptBinding,
  persistDispatchedProtected0058Attempt,
  persistPreparedProtected0058Attempt,
  readProtected0058Attempt,
} from "./schema-0058-apply-receipt.ts";
import { assertProtected0058Preserved, type Protected0058Snapshot } from "./schema-0058-proof.ts";

export interface Protected0058TransitionInput {
  readonly custodyPath: string;
  readonly binding: Protected0058AttemptBinding;
  readonly importArtifact: {
    readonly sql: string;
    readonly digest: string;
    readonly bytes: number;
  };
  readonly expectedPostShape: string;
  readonly readState: () => Promise<D1SchemaState>;
  readonly readSnapshot: () => Promise<Protected0058Snapshot>;
  /** The sole schema writer supplies its one exact Wrangler --file invocation. */
  readonly importOnce: () => Promise<"acknowledged" | "unknown">;
}

export interface Protected0058TransitionResult {
  readonly post: D1SchemaState;
  readonly providerAcknowledgement:
    | "acknowledged"
    | "provider-error-recovered-by-authoritative-readback"
    | "reconciled-complete-without-second-apply";
}

const MIGRATION = "0058_cloudflare_managed_worker_domain_receipts.sql";

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function validateBinding(
  input: Pick<Protected0058TransitionInput, "binding" | "importArtifact">,
  dispatched = false,
): void {
  const { binding, importArtifact } = input;
  if (
    binding.source.prefix.length !== 58 ||
    binding.source.prefix[57]?.name !== MIGRATION ||
    !same(
      binding.before.lineage,
      binding.source.prefix.slice(0, 57).map((file) => file.name),
    ) ||
    binding.source.importDigest !== importArtifact.digest ||
    binding.source.importBytes !== importArtifact.bytes ||
    `sha256:${createHash("sha256").update(importArtifact.sql).digest("hex")}` !==
      importArtifact.digest ||
    Buffer.byteLength(importArtifact.sql, "utf8") !== importArtifact.bytes
  ) {
    if (dispatched) {
      throw mutationError("0058 dispatched source and import binding disagree; retain custody");
    }
    throw preflightError("0058 protected source and import binding disagree");
  }
}

function assertBinding(
  input: Protected0058TransitionInput,
): ReturnType<typeof readProtected0058Attempt> {
  const existing = readProtected0058Attempt(input.custodyPath);
  if (
    existing !== null &&
    !same(
      {
        environment: existing.environment,
        target: existing.target,
        source: existing.source,
        before: existing.before,
      },
      input.binding,
    )
  ) {
    if (existing.state === "dispatched") {
      throw mutationError(
        "0058 dispatched attempt target, source, or predecessor changed; retain custody",
      );
    }
    throw preflightError("0058 protected attempt target, source, or predecessor changed");
  }
  return existing;
}

async function verifyPost(
  input: Pick<
    Protected0058TransitionInput,
    "binding" | "expectedPostShape" | "readState" | "readSnapshot"
  >,
): Promise<D1SchemaState> {
  let post: D1SchemaState;
  try {
    post = await input.readState();
  } catch {
    throw mutationError(
      "0058 dispatched attempt authoritative lineage readback is unavailable; retain custody",
    );
  }
  const expectedLineage = input.binding.source.prefix.map((file) => file.name);
  if (!same(post.applied, expectedLineage)) {
    throw mutationError(
      "0058 dispatched attempt is not at the exact completed lineage; never replay import",
    );
  }
  let exactPostShape = false;
  try {
    exactPostShape = applicationSchemaMatches(post, input.expectedPostShape);
  } catch {
    throw mutationError("0058 dispatched post-schema readback is invalid; retain custody");
  }
  if (!exactPostShape) {
    throw mutationError(
      "0058 dispatched attempt lacks the exact canonical post-schema; repair forward",
    );
  }
  let snapshot: Protected0058Snapshot;
  try {
    snapshot = await input.readSnapshot();
  } catch {
    throw mutationError(
      "0058 dispatched attempt protected-data readback is unavailable; retain custody",
    );
  }
  try {
    assertProtected0058Preserved(input.binding.before.snapshot, snapshot);
  } catch {
    throw mutationError(
      "0058 affected-table rows or sealed BLOB bytes changed across dispatched import; retain custody and repair forward",
    );
  }
  return post;
}

/** A new sole-writer invocation may only inspect a prior dispatched attempt. */
export async function reconcileDispatchedProtected0058Transition(
  input: Omit<Protected0058TransitionInput, "binding" | "importOnce"> & {
    readonly expectedScope: Pick<Protected0058AttemptBinding, "environment" | "target" | "source">;
  },
): Promise<Protected0058TransitionResult> {
  const attempt = readProtected0058Attempt(input.custodyPath);
  if (attempt?.state !== "dispatched") {
    throw preflightError("0058 has no dispatched protected attempt to reconcile");
  }
  if (
    attempt.environment !== input.expectedScope.environment ||
    !same(attempt.target, input.expectedScope.target) ||
    !same(attempt.source, input.expectedScope.source)
  ) {
    throw mutationError(
      "0058 dispatched attempt target or source differs from this invocation; retain custody",
    );
  }
  const binding = {
    environment: attempt.environment,
    target: attempt.target,
    source: attempt.source,
    before: attempt.before,
  };
  validateBinding({ binding, importArtifact: input.importArtifact }, true);
  return {
    post: await verifyPost({ ...input, binding }),
    providerAcknowledgement: "reconciled-complete-without-second-apply",
  };
}

/**
 * One forward import after durable dispatch. A reopened dispatched attempt is
 * read-only, even if its import returned an error or the process died.
 * Qualification and admission remain the sole writer's separate responsibility.
 */
export async function runProtected0058Transition(
  input: Protected0058TransitionInput,
): Promise<Protected0058TransitionResult> {
  let existing = assertBinding(input);
  validateBinding(input, existing?.state === "dispatched");
  if (existing?.state === "dispatched") {
    return {
      post: await verifyPost(input),
      providerAcknowledgement: "reconciled-complete-without-second-apply",
    };
  }
  const current = await input.readState();
  if (
    !same(current.applied, input.binding.before.lineage) ||
    current.shapeDigest !== input.binding.before.shapeDigest ||
    !same(await input.readSnapshot(), input.binding.before.snapshot)
  )
    throw preflightError("0058 protected predecessor changed before dispatch");
  if (existing === null) {
    existing = persistPreparedProtected0058Attempt(input.custodyPath, input.binding);
  }
  persistDispatchedProtected0058Attempt(input.custodyPath, input.binding, existing);
  let acknowledgement: "acknowledged" | "unknown" = "unknown";
  try {
    acknowledgement = await input.importOnce();
  } catch {
    // A transport exception is not evidence that the import was not committed.
  }
  try {
    return {
      post: await verifyPost(input),
      providerAcknowledgement:
        acknowledgement === "acknowledged"
          ? "acknowledged"
          : "provider-error-recovered-by-authoritative-readback",
    };
  } catch (error) {
    if (error instanceof Error) throw error;
    throw mutationError("0058 dispatched import outcome is indeterminate; retain attempt");
  }
}
