import type { IntegrationOrganizationBootstrapStatus } from "../../src/auth.ts";
import {
  INTEGRATION_ORGANIZATION_BOOTSTRAP_PROOF_MAX_TTL_SECONDS,
  INTEGRATION_ORGANIZATION_ID,
  INTEGRATION_ORGANIZATION_NAME,
  type IntegrationOrganizationBootstrapAction,
  type IntegrationOrganizationBootstrapRequestBody,
  integrationOrganizationBootstrapClaims,
  integrationOrganizationBootstrapPath,
  integrationOrganizationBootstrapRequestBody,
} from "../../src/integration-organization-bootstrap.ts";
import { canonicalOperatorAudience } from "../../src/operator-credentials.ts";
import { signOperatorAssertion } from "../../src/operator-key.ts";
import { parseStrictJson } from "../../src/strict-json.ts";
import { CloudflareState } from "./cloudflare-state.ts";
import { DeployError, type DeployPhase, preflightError } from "./errors.ts";
import {
  OPERATOR_IDENTITY_ENV,
  OPERATOR_PRIVATE_JWK_ENV,
  provePrivateMatchesPublic,
  readOperatorSignInIdentity,
  readPrivateJwk,
} from "./operator-authority.ts";
import {
  type CommandResult,
  requireEnvironment,
  resolveCloudflareCredential,
  runCommand,
} from "./process.ts";
import { type DeployEnvironment, qualifySource } from "./qualification.ts";
import type { DeployTarget } from "./target.ts";
import {
  inspectLiveWorkerVersion,
  type LiveWorkerVersion,
  type WorkerState,
} from "./worker-live.ts";

export interface IntegrationOrganizationBootstrapInvocation {
  readonly surface: "takoserver-integration-organization-bootstrap";
  readonly action: IntegrationOrganizationBootstrapAction;
  readonly environment: DeployEnvironment;
  readonly commit: string;
}

export interface IntegrationOrganizationBootstrapOptions {
  readonly state?: WorkerState;
  readonly run?: (
    command: readonly string[],
    options?: { readonly env?: Readonly<Record<string, string>>; readonly input?: string },
  ) => Promise<CommandResult>;
  readonly cloudflareEnvironment?: Readonly<Record<string, string>>;
  readonly fetcher?: (url: string, init?: RequestInit) => Promise<Response>;
  readonly review?: string;
  readonly privateJwkPath?: string;
  readonly operatorIdentityPath?: string;
  readonly now?: () => Date;
}

/** Existing operator authority; only the fixed integration org/member tuple may change. */
export async function runIntegrationOrganizationBootstrap(
  invocation: IntegrationOrganizationBootstrapInvocation,
  target: DeployTarget,
  options: IntegrationOrganizationBootstrapOptions = {},
): Promise<Record<string, unknown>> {
  if (invocation.environment !== "integration" || target.environment !== "integration") {
    throw preflightError("organization bootstrap is integration-only");
  }
  if (invocation.action !== "status" && invocation.action !== "apply") {
    throw preflightError("organization bootstrap accepts only status or apply");
  }
  try {
    if (
      !target.publicOrigin.startsWith("https://") ||
      canonicalOperatorAudience(target.publicOrigin) !== target.publicOrigin
    )
      throw new Error("noncanonical origin");
  } catch {
    throw preflightError("organization bootstrap requires one canonical HTTPS Host origin");
  }
  if (
    !target.operatorIdentity ||
    target.integrationE2eCredentialAuthority?.organizationId !== INTEGRATION_ORGANIZATION_ID
  ) {
    throw preflightError(
      "organization bootstrap requires the existing integration operator and JIT configuration",
    );
  }
  const run = options.run ?? runCommand;
  const source = await qualifySource({
    environment: "integration",
    commit: invocation.commit,
    run,
  });
  const reviewer =
    invocation.action === "apply"
      ? (options.review ?? requireEnvironment("TAKOSERVER_INDEPENDENT_REVIEW"))
      : undefined;
  if (reviewer !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._@+-]{0,199}$/u.test(reviewer)) {
    throw preflightError("organization bootstrap requires an exact independent reviewer");
  }
  const credential =
    options.state === undefined
      ? await resolveCloudflareCredential("integration", {
          cloudflareEnvironment: options.cloudflareEnvironment,
          run,
        })
      : undefined;
  const state =
    options.state ??
    (() => {
      if (!credential)
        throw preflightError("organization bootstrap native credential is unavailable");
      return new CloudflareState({ accountId: target.accountId, token: credential.token });
    })();
  let phase: DeployPhase = "preflight";
  const failure = (message: string) => new DeployError(phase, message);
  const inspect = async (): Promise<LiveWorkerVersion> => {
    try {
      const live = await inspectLiveWorkerVersion("preflight", target, state, {
        authorityProfile: { kind: "provenance-bound-jit" },
      });
      if (live.commit !== source.commit) throw new Error("source mismatch");
      return live;
    } catch {
      throw failure("organization bootstrap Host provenance or target closure is unavailable");
    }
  };
  const live = await inspect();
  // Native closure proves the configured identity key before its private half is opened.
  const privateInput = readPrivateJwk(
    options.privateJwkPath ?? requireEnvironment(OPERATOR_PRIVATE_JWK_ENV),
  );
  await provePrivateMatchesPublic(privateInput, target.operatorIdentity.publicJwk);
  const owner = readOperatorSignInIdentity(
    options.operatorIdentityPath ?? requireEnvironment(OPERATOR_IDENTITY_ENV),
  );
  const identity = {
    environment: "integration" as const,
    hostId: target.publicOrigin,
    sourceCommit: live.commit,
    artifactDigest: `sha256:${live.bundleDigestHex}` as const,
    publicWorkerVersionId: live.history.versionId,
  };
  const fetcher = options.fetcher ?? fetch;
  const now = options.now ?? (() => new Date());
  let mutationAcknowledged = false;
  const request = async (
    action: IntegrationOrganizationBootstrapAction,
    body: IntegrationOrganizationBootstrapRequestBody,
  ): Promise<{
    readonly status: IntegrationOrganizationBootstrapStatus;
    readonly created: boolean;
  }> => {
    let assertion: string;
    try {
      assertion = await signOperatorAssertion({
        privateJwk: JSON.stringify(privateInput.jwk),
        claims: await integrationOrganizationBootstrapClaims({ action, body, identity }),
        nowSeconds: Math.floor(now().getTime() / 1_000),
        lifetimeSeconds: INTEGRATION_ORGANIZATION_BOOTSTRAP_PROOF_MAX_TTL_SECONDS,
      });
    } catch {
      throw failure("organization bootstrap proof signing failed; credentials redacted");
    }
    if (action === "apply") phase = "mutation";
    let response: Response;
    try {
      response = await fetcher(
        `${target.publicOrigin}${integrationOrganizationBootstrapPath(action)}`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${assertion}`,
            "content-type": "application/json",
            "cache-control": "no-store",
          },
          body: JSON.stringify(body),
          redirect: "error",
          signal: AbortSignal.timeout(30_000),
        },
      );
    } catch {
      throw failure("organization bootstrap transport failed; use status before any new apply");
    }
    const accepted = response.status === 200 || (action === "apply" && response.status === 201);
    if (action === "apply" && accepted) {
      mutationAcknowledged = true;
      phase = "verification";
    }
    if (!accepted) {
      await response.body?.cancel().catch(() => undefined);
      // This owner endpoint's 4xx replies prove rejection/atomic rollback, not unknown commit.
      if (action === "apply" && response.status >= 400 && response.status < 500)
        phase = "preflight";
      throw failure(
        `organization bootstrap ${action} returned HTTP ${response.status}; response redacted`,
      );
    }
    let status: IntegrationOrganizationBootstrapStatus;
    try {
      status = await readStatus(response, body.ownerPrincipalId);
      if (action === "apply" && status.state !== "present")
        throw new Error("apply did not converge");
    } catch {
      throw failure(
        "organization bootstrap response is not the exact owner tuple; use status before any new apply",
      );
    }
    return { status, created: response.status === 201 };
  };
  const sameLive = async () => {
    const current = await inspect();
    if (
      current.history.versionId !== live.history.versionId ||
      current.bundleDigestHex !== live.bundleDigestHex
    ) {
      throw failure("organization bootstrap Host changed; use status before any new apply");
    }
  };
  const statusBody = integrationOrganizationBootstrapRequestBody({ owner });
  const before = (await request("status", statusBody)).status;
  await sameLive();
  let result = before;
  let created = false;
  if (invocation.action === "apply" && before.state === "eligible") {
    const applied = await request(
      "apply",
      integrationOrganizationBootstrapRequestBody({
        owner,
        ownerPrincipalId: before.ownerPrincipalId,
      }),
    );
    created = applied.created;
    const after = (await request("status", statusBody)).status;
    if (JSON.stringify(after) !== JSON.stringify(applied.status)) {
      throw failure("organization bootstrap post-readback differs from the acknowledged tuple");
    }
    await sameLive();
    result = after;
  }
  return {
    kind: "takoserver.integration-organization-bootstrap-invocation@v1",
    surface: invocation.surface,
    action: invocation.action,
    ...identity,
    dirty: source.dirty,
    ...(reviewer === undefined ? {} : { reviewer }),
    result,
    mutationApplied: created,
    mutationAcknowledged,
    ready: result.state === "present",
    credentialsRedacted: true,
  };
}

async function readStatus(
  response: Response,
  expectedOwnerPrincipalId?: string,
): Promise<IntegrationOrganizationBootstrapStatus> {
  if (
    response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !==
      "application/json" ||
    !response.body
  ) {
    throw new Error("invalid response type");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > 8 * 1_024) {
        await reader.cancel();
        throw new Error("response too large");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const value = parseStrictJson(bytes, 8 * 1_024);
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("invalid status");
  const record = value as Record<string, unknown>;
  const keys = [
    "kind",
    "state",
    "organizationId",
    "organizationName",
    "ownerPrincipalId",
    "createdAt",
  ];
  if (
    Object.keys(record).length !== keys.length ||
    !keys.every((key) => Object.hasOwn(record, key)) ||
    record.kind !== "takoserver.integration-organization-bootstrap-status@v1" ||
    (record.state !== "eligible" && record.state !== "present") ||
    record.organizationId !== INTEGRATION_ORGANIZATION_ID ||
    record.organizationName !== INTEGRATION_ORGANIZATION_NAME ||
    typeof record.ownerPrincipalId !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(record.ownerPrincipalId) ||
    (expectedOwnerPrincipalId !== undefined &&
      record.ownerPrincipalId !== expectedOwnerPrincipalId) ||
    (record.state === "eligible"
      ? record.createdAt !== null
      : typeof record.createdAt !== "string" || !Number.isFinite(Date.parse(record.createdAt)))
  )
    throw new Error("invalid status tuple");
  return {
    state: record.state,
    organizationId: INTEGRATION_ORGANIZATION_ID,
    organizationName: INTEGRATION_ORGANIZATION_NAME,
    ownerPrincipalId: record.ownerPrincipalId,
    createdAt: record.createdAt as string | null,
  };
}
