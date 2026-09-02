import { Database } from "bun:sqlite";
import { resolve } from "node:path";
import { canonicalDigest } from "../src/json.ts";
import { createFileObjectStore } from "../src/objects-fs.ts";
import type { ObjectStore, Sql } from "../src/ports.ts";
import { derivePublicFormImplementationIdentity } from "../src/public-worker-implementation.ts";
import { SELFHOST_IDENTITY_CAPABILITY_KINDS } from "../src/selfhost-composition.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import {
  readReleasedCoreVerifierIdentity,
  type TakoformCoreVerifierContainerNamespace,
} from "../src/takoform/form-authority-verification.ts";
import type {
  FormAuthorityApplyResult,
  FormAuthorityPlan,
  FormAuthorityPlanRequest,
} from "../src/takoform/host-admission-coordinator.ts";
import {
  createProductionFormAuthorityComposition,
  deriveFormAuthorityIdentity,
  type FormAuthorityEndpointConfiguration,
} from "../src/takoform/host-admission-endpoint.ts";
import { yurucommuLifecycleCapabilityManifest } from "../src/takoform/implementation-catalog.ts";
import { loadPublisherSetClosure } from "../src/takoform/publisher-set-closure.ts";
import { takoformCoreVerifierArtifactDigest } from "./deploy/form-authority.ts";

/**
 * Self-host Form admission.
 *
 * A fresh Bun self-host reads the same durable admission chain as the
 * Cloudflare Worker but has no route-less authority Worker to write it, so it
 * serves zero Forms until an operator records the publisher, checkpoint,
 * install, support, and activation events. This command is that operator
 * path. It imports the exact embedded publisher set (all 17 packages), has
 * every raw package, policy, trusted root, and checkpoint re-verified by the
 * released Takoform Core verifier, and activates the implemented subset for
 * one organization and Space. It never invents a Form: the closure shipped in
 * the running Takoserver build is the only package source.
 *
 *   bun scripts/selfhost-form-admission.ts <organizationId> <space> [--apply]
 *     [--data-root .takoserver] [--host-id http://localhost:8787]
 *     [--core-verifier http://127.0.0.1:8080]
 *
 * Reads and plans only, until `--apply`. Stop the Takoserver process first:
 * the file object store admits one writer at a time and refuses a second.
 * The released Core verifier is the `services/takoform-core-verifier` binary
 * started with the exact artifact digest this checkout computes; the command
 * refuses any verifier whose live identity differs.
 */
export interface SelfhostFormAdmissionOptions {
  readonly organizationId: string;
  readonly space: string;
  readonly hostId: string;
  readonly coreVerifierUrl: string;
  readonly apply: boolean;
  readonly sql: Sql;
  readonly objects: ObjectStore;
  readonly fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
}

export interface SelfhostFormAdmissionResult {
  readonly plan: FormAuthorityPlan;
  readonly applied: FormAuthorityApplyResult | null;
}

export async function runSelfhostFormAdmission(
  options: SelfhostFormAdmissionOptions,
): Promise<SelfhostFormAdmissionResult> {
  requireIdentifier(options.organizationId, "organization id");
  requireIdentifier(options.space, "space");
  const coreUrl = new URL(options.coreVerifierUrl);
  if (coreUrl.protocol !== "http:" && coreUrl.protocol !== "https:") {
    throw new Error("core verifier URL must be http(s)");
  }
  const fetcher = options.fetch ?? fetch;
  const artifactDigest = takoformCoreVerifierArtifactDigest();
  const coreVerifier: TakoformCoreVerifierContainerNamespace = {
    idFromName: (name) => ({ toString: () => name, equals: () => true }),
    get: () => ({
      fetch: (input, init) => {
        const path = new URL(
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
        ).pathname;
        return fetcher(new URL(path, coreUrl).toString(), init);
      },
    }),
  };
  // Fail before touching durable state when the verifier is not the exact
  // released Core this checkout was built against.
  await readReleasedCoreVerifierIdentity({
    containers: coreVerifier,
    containerName: `selfhost:${options.hostId}`,
    artifactDigest,
  });

  // The self-host has no separately sealed Worker payload; its Form
  // implementation identity is the canonical digest of the capability manifest
  // it serves, recorded as provenance on every support and activation event.
  // Exactly the identity Forms this machine's composition realizes. That now
  // includes `ObjectBucket`: a self-host holds object bodies under its data
  // root and its Provider Pack owns both halves of the
  // `module-worker.object-bucket` materialization, so the Form is recorded with
  // the five operations it declares rather than with the empty set ADR 0007
  // describes for a Host without that supply (see its second rotation).
  const capabilities = yurucommuLifecycleCapabilityManifest(SELFHOST_IDENTITY_CAPABILITY_KINDS);
  const implementationPayloadDigest = await canonicalDigest({
    kind: "takoserver.selfhost-form-implementation@v1",
    capabilities,
  });
  const semantic = await derivePublicFormImplementationIdentity({
    implementationPayloadDigest,
    capabilities,
  });
  const configuration: FormAuthorityEndpointConfiguration = {
    environment: "production",
    hostId: options.hostId,
    workerArtifactDigest: implementationPayloadDigest,
    publicWorkerVersionId: "00000000-0000-4000-8000-000000000000",
    implementationPayloadDigest: semantic.implementationPayloadDigest,
    implementationDigest: semantic.implementationDigest,
    capabilities,
    coreVerifierArtifactDigest: artifactDigest,
  };
  const identity = await deriveFormAuthorityIdentity(configuration);
  const live = {
    kind: "takoserver.public-host-identity@v2" as const,
    hostId: identity.hostId,
    workerVersionId: identity.publicWorkerVersionId,
    workerArtifactDigest: identity.workerArtifactDigest,
    implementationPayloadDigest: semantic.implementationPayloadDigest,
    capabilityDigest: semantic.capabilityDigest,
    implementationDigest: identity.implementationDigest,
  };
  const composition = await createProductionFormAuthorityComposition({
    configuration,
    bindings: {
      sql: options.sql,
      objects: options.objects,
      publicHostIdentity: {
        async identity() {
          return live;
        },
      },
      coreVerifier,
    },
  });
  const closure = await loadPublisherSetClosure();
  const request: FormAuthorityPlanRequest = {
    kind: "takoserver.form-authority-plan-request@v2",
    ...composition.identity,
    activation: {
      kind: "space",
      tenantId: options.organizationId,
      space: options.space,
      desiredActive: true,
    },
    evidence: closure.evidence,
    actor: "takoserver-selfhost-operator",
    reason: `self-host admission of ${closure.identity.setTag} for ${options.organizationId}/${options.space}`,
  };
  const plan = await composition.endpoint.plan(request);
  if (!options.apply) return { plan, applied: null };
  const applied = await composition.endpoint.apply(plan);
  return { plan, applied };
}

function requireIdentifier(value: string, name: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value)) {
    throw new Error(`${name} is invalid`);
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const positional = args.filter((argument) => !argument.startsWith("--"));
  const flag = (name: string): string | undefined => {
    const index = args.indexOf(`--${name}`);
    return index === -1 ? undefined : args[index + 1];
  };
  const [organizationId, space] = positional;
  if (!organizationId || !space) {
    process.stderr.write(
      "usage: selfhost-form-admission.ts <organizationId> <space> [--apply] [--data-root DIR] [--host-id ORIGIN] [--core-verifier URL]\n",
    );
    process.exit(2);
  }
  const dataRoot = resolve(flag("data-root") ?? process.env.TAKOSERVER_DATA_ROOT ?? ".takoserver");
  const database = new Database(`${dataRoot}/control.sqlite`);
  try {
    const result = await runSelfhostFormAdmission({
      organizationId,
      space,
      hostId: flag("host-id") ?? process.env.TAKOSERVER_PUBLIC_ORIGIN ?? "http://localhost:8787",
      coreVerifierUrl: flag("core-verifier") ?? "http://127.0.0.1:8080",
      apply: args.includes("--apply"),
      sql: createSqliteSql(database),
      objects: createFileObjectStore({ root: dataRoot }),
    });
    const { plan, applied } = result;
    process.stdout.write(
      `plan: ${plan.commands.length} command(s) over ${plan.packages.length} package(s)\n`,
    );
    if (!applied) {
      process.stdout.write("dry run; pass --apply to record the admission chain\n");
    } else {
      const forms = applied.readback.forms;
      process.stdout.write(
        `apply: ${applied.status} (${applied.receipts.length} receipt(s), ${applied.verificationMode})\n` +
          `installed ${forms.filter((form) => form.installed).length}, supported ${
            forms.filter((form) => form.supported).length
          }, active ${forms.filter((form) => form.activationHead.active).length}\n`,
      );
      if (applied.failure) {
        process.stdout.write(
          `failure at command ${applied.failure.index}: ${applied.failure.code}; run status and re-plan\n`,
        );
        process.exitCode = 1;
      }
    }
  } finally {
    database.close();
  }
}
