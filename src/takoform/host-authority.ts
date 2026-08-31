import type { TakoformV1Alpha3FormRef } from "../form-ref.ts";
import { canonicalDigest, canonicalJson, isJsonObject, isSha256Digest } from "../json.ts";
import type { ObjectStoreAccess, Row, Sql } from "../ports.ts";
import {
  ADMISSION_GENESIS_DIGEST,
  type AdmissionDigest,
  TAKOFORM_REVOCATION_V1,
  TAKOFORM_REVOCATION_V1_EMPTY_ENTRIES_DIGEST,
  TAKOFORM_REVOCATION_V1_GENESIS_DIGEST,
  TAKOFORM_REVOCATION_V1ALPHA1,
  type TakoformRevocationCheckpointApiVersion,
} from "./admission-digest.ts";
import {
  type AdmissionProjectionActivation,
  type AdmissionProjectionCheckpoint,
  type AdmissionProjectionCurrentHeads,
  type AdmissionProjectionHistory,
  type AdmissionProjectionInstall,
  type AdmissionProjectionPublisher,
  type AdmissionProjectionRetention,
  type AdmissionProjectionSupport,
  evaluateAdmissionProjection,
} from "./admission-projection.ts";
import type { BindingRegistry } from "./bindings.ts";
import { installedBindings } from "./bindings.ts";
import { installedFormFromDefinition } from "./form-definition.ts";
import { createFormPackageReader, type FormPackageReader } from "./form-package-reader.ts";
import {
  exactInstalledForm,
  formGroupFromApiVersion,
  formKey,
  installedForms,
  isDefinitionVersion,
  isFormApiVersion,
  isKind,
  sameFormRef,
} from "./forms.ts";
import {
  type InstalledTakoformBinding,
  type InstalledTakoformForm,
  type TakoformFormAvailability,
  type TakoformFormAvailabilityResolver,
  TakoformHostError,
  type TakoformOperation,
  type TakoformStoredResource,
} from "./types.ts";

const PUBLISHER_TABLE = "tf_form_publisher_events" as const;
const CHECKPOINT_TABLE = "tf_form_revocation_checkpoints" as const;
const INSTALL_TABLE = "tf_form_install_events" as const;
const SUPPORT_TABLE = "tf_form_support_events" as const;
const ACTIVATION_TABLE = "tf_form_activation_events" as const;
const PURGE_TABLE = "tf_form_package_purge_events" as const;

const MUTATION_OPERATIONS = new Set<TakoformOperation>(["create", "update", "import"]);
const ALL_OPERATIONS = new Set<TakoformOperation>([
  "create",
  "read",
  "update",
  "delete",
  "import",
  "observe",
]);
const MAX_CURRENT_FORMS = 128;
const CATALOG_FORM_CONCURRENCY = 4;

export interface TakoformAuthorityRequestContext {
  readonly tenantId: string;
  readonly principalId: string;
  readonly space: string;
}

export interface TakoformAuthoritySupportContext {
  readonly tenantId: string;
  readonly principalId: string;
}

export type TakoformAuthorityHeadKind =
  | "publisher"
  | "checkpoint"
  | "install"
  | "support"
  | "activation"
  | "purge"
  | "install-event";

/** One exact D1 fact that must still be current when a resource commit wins. */
export interface TakoformAuthorityHeadExpectation {
  readonly kind: TakoformAuthorityHeadKind;
  readonly key: string;
  readonly eventDigest: AdmissionDigest | null;
}

/** Opaque-to-callers but typed-to-the-store current-head compare-and-swap. */
export interface TakoformAuthorityFence {
  readonly version: "takoserver.takoform-authority-fence@v1";
  readonly mode: "mutation" | "retained-cleanup";
  readonly packageDigest: AdmissionDigest;
  readonly implementationDigest: AdmissionDigest;
  readonly headDigest: AdmissionDigest;
  readonly heads: readonly TakoformAuthorityHeadExpectation[];
}

export interface TakoformAuthorityCurrentHeads extends AdmissionProjectionCurrentHeads {
  readonly publisher: AdmissionProjectionPublisher;
  readonly checkpoint: AdmissionProjectionCheckpoint;
  readonly install: AdmissionProjectionInstall;
  readonly support: AdmissionProjectionSupport;
  readonly activations: readonly AdmissionProjectionActivation[];
}

export interface TakoformAuthorityGrant {
  readonly form: InstalledTakoformForm;
  readonly packageDigest: AdmissionDigest;
  readonly implementationDigest: AdmissionDigest;
  readonly current: TakoformAuthorityCurrentHeads;
  readonly fence: TakoformAuthorityFence;
}

export interface TakoformRetainedAuthorityGrant {
  readonly form: InstalledTakoformForm;
  readonly packageDigest: AdmissionDigest;
  readonly implementationDigest: AdmissionDigest;
  readonly history: AdmissionProjectionHistory;
  readonly retention: AdmissionProjectionRetention;
  readonly fence: TakoformAuthorityFence;
}

export interface TakoformAuthorityCatalogEntry {
  readonly form: InstalledTakoformForm;
  readonly availability: TakoformFormAvailability;
  /** Durable support before principal/Space activation and provider narrowing. */
  readonly supported: boolean;
  readonly headDigest: AdmissionDigest;
}

export interface TakoformAuthorityCatalog {
  readonly forms: readonly TakoformAuthorityCatalogEntry[];
  readonly bindings: readonly InstalledTakoformBinding[];
}

/** One exact public support lookup; no route needs to materialize the catalog. */
export type TakoformAuthoritySupportLookup =
  | {
      readonly target: "form";
      readonly apiVersion: string;
      readonly kind: string;
      readonly definitionVersion: string;
    }
  | { readonly target: "interface"; readonly name: string; readonly version: string }
  | { readonly target: "binding"; readonly name: string; readonly version: string };

/** The authoritative projection returned by a targeted support lookup. */
export interface TakoformAuthoritySupportProjection {
  readonly forms: readonly TakoformAuthorityCatalogEntry[];
  readonly bindings: readonly InstalledTakoformBinding[];
}

export interface TakoformHostAuthority {
  /** Fresh installed/support/activation truth for public discovery. */
  catalog(context: TakoformAuthorityRequestContext): Promise<TakoformAuthorityCatalog>;
  /** Fresh installed/support truth for the support-profile surface. */
  supportCatalog(context: TakoformAuthoritySupportContext): Promise<TakoformAuthorityCatalog>;
  /**
   * Fresh exact support truth for one Form/Interface/Binding query. This is
   * optional for compatibility with historical in-process authorities; the
   * durable implementation always supplies it and routes use it when present.
   */
  lookupSupport?(
    context: TakoformAuthoritySupportContext,
    query: TakoformAuthoritySupportLookup,
  ): Promise<TakoformAuthoritySupportProjection>;
  /** Current authority for a new create/import/update. */
  authorizeMutation(input: {
    readonly operation: "create" | "import" | "update";
    readonly context: TakoformAuthorityRequestContext;
    readonly formRef: TakoformV1Alpha3FormRef;
  }): Promise<TakoformAuthorityGrant>;
  /** Historical byte/identity authority for retained observe/delete/evacuate. */
  authorizeRetained(input: {
    readonly operation: "observe" | "delete" | "evacuate";
    readonly context: TakoformAuthorityRequestContext;
    readonly resource: TakoformStoredResource;
  }): Promise<TakoformRetainedAuthorityGrant>;
}

export interface CreateTakoformHostAuthorityOptions {
  readonly sql: Sql;
  readonly objects?: Pick<ObjectStoreAccess, "get" | "list">;
  readonly packages?: FormPackageReader;
  readonly hostId: string;
  /** Current Worker Version is retained only as operation/audit provenance. */
  readonly publicWorkerVersionId?: string;
  /** Current semantic Form implementation identity. */
  readonly implementationDigest?: AdmissionDigest;
  /** Build/operator inputs only; these bytes do not confer any runtime authority. */
  readonly candidates: readonly InstalledTakoformForm[];
  readonly bindings?: readonly InstalledTakoformBinding[];
  /** Provider facts can only narrow a durable support/activation decision. */
  readonly technicalAvailability: TakoformFormAvailabilityResolver;
}

interface CurrentBase {
  readonly formRefKey: AdmissionDigest;
  readonly supportKey: AdmissionDigest;
  readonly form: InstalledTakoformForm;
  readonly publisher: AdmissionProjectionPublisher;
  readonly checkpoint: AdmissionProjectionCheckpoint;
  readonly install: AdmissionProjectionInstall;
  readonly support: AdmissionProjectionSupport;
  readonly baseSupported: boolean;
  readonly heads: readonly TakoformAuthorityHeadExpectation[];
}

interface ActivationRead {
  readonly facts: readonly AdmissionProjectionActivation[];
  readonly heads: readonly TakoformAuthorityHeadExpectation[];
}

/**
 * Read-only Host admission projection.
 *
 * Every method performs fresh D1 and R2 reads. There is deliberately no
 * isolate-local head cache: an append-only successor must affect the very next
 * request, including a deferred operation resumed by a warm Worker.
 */
export function createTakoformHostAuthority(
  options: CreateTakoformHostAuthorityOptions,
): TakoformHostAuthority {
  requireIdentity(options.hostId, "host id");
  if (
    options.publicWorkerVersionId !== undefined &&
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(
      options.publicWorkerVersionId,
    )
  ) {
    throw new TypeError("public Worker Version identity is invalid");
  }
  if (options.implementationDigest !== undefined && !isSha256Digest(options.implementationDigest)) {
    throw new TypeError("public Worker semantic identity is invalid");
  }
  if (
    !options.technicalAvailability ||
    typeof options.technicalAvailability.resolve !== "function"
  ) {
    throw new TypeError("technical availability is required");
  }
  const packages =
    options.packages ??
    (options.objects ? createFormPackageReader(options.objects) : unavailablePackageReader());
  const candidates = installedForms(options.candidates, "forms.takoform.com/v1");
  const bindings = installedBindings(options.bindings ?? []);
  for (const form of candidates.values()) {
    if (!isSha256Digest(form.identity.packageDigest)) {
      throw new TypeError("every authority candidate needs an exact package digest");
    }
  }

  const execute = async <T>(operation: () => Promise<T>): Promise<T> => {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof TakoformHostError) throw error;
      throw unavailable();
    }
  };

  const currentBase = async (
    formRef: TakoformV1Alpha3FormRef,
    absence: "null" | "error",
    knownInstallRow?: Row,
    readMode: "definition" | "package" = "definition",
  ): Promise<CurrentBase | null> => {
    const formRefKey = asDigest(await canonicalDigest(formRef));
    const installRow =
      knownInstallRow ?? (await exactHead(options.sql, INSTALL_TABLE, "form_ref_key", formRefKey));
    if (!installRow || text(installRow, "event_type") === "uninstall") {
      if (absence === "error") throw unavailable();
      return null;
    }
    const install = readInstall(installRow, formRefKey, formRef);
    if (install.eventType !== "install" && install.eventType !== "replace") throw unavailable();

    const supportKey = asDigest(
      await canonicalDigest({ formRefKey, packageDigest: install.packageDigest }),
    );
    const [publisherRow, checkpointRow, supportRow] = await Promise.all([
      exactHead(options.sql, PUBLISHER_TABLE, "publisher_key", install.publisherKey),
      exactCheckpointHead(options.sql, install.publisherKey, install.checkpointApiVersion),
      exactHead(options.sql, SUPPORT_TABLE, "support_key", supportKey),
    ]);
    if (!publisherRow || !checkpointRow || !supportRow) {
      if (absence === "error") throw unavailable();
      return null;
    }
    const publisher = readPublisher(publisherRow, install.publisherKey);
    const checkpoint = readCheckpoint(checkpointRow, install.publisherKey);
    const support = readSupport(supportRow, supportKey, formRefKey, formRef, install.packageDigest);
    const currentImplementationProfile = supportProfileMatchesPublicWorker(
      supportRow,
      support.implementationDigest,
      options.implementationDigest,
    );
    await validateEvidencePins({
      publisherRow,
      checkpointRow,
      installRow,
      publisher,
      checkpoint,
      install,
    });
    const durableForm = await readDurableForm(readMode, formRef, install.packageDigest);
    if (!durableForm) {
      throw unavailable();
    }
    const compiledCandidate = exactInstalledForm(formRef, candidates);
    const implementationCandidate =
      compiledCandidate?.identity.packageDigest === install.packageDigest
        ? compiledCandidate
        : null;
    const implementationDigest = support.implementationDigest;
    if (
      install.implementationDigest !== undefined &&
      install.implementationDigest !== implementationDigest
    ) {
      throw unavailable();
    }
    const narrowedOperations = implementationCandidate
      ? implementationCandidate.operations.filter((operation) =>
          support.operations.includes(operation),
        )
      : [];
    const form: InstalledTakoformForm = {
      ...structuredClone(implementationCandidate ?? durableForm),
      identity: {
        formRef: structuredClone(formRef),
        packageDigest: install.packageDigest,
        implementationDigest,
      },
      operations: narrowedOperations,
    };
    const publisherCurrent = publisher.eventType === "allow" || publisher.eventType === "rotate";
    const checkpointCurrent =
      checkpoint.verified &&
      !checkpoint.stale &&
      checkpoint.policyDigest === publisher.policyDigest &&
      checkpoint.policyEventDigest === publisher.eventDigest &&
      !checkpoint.revokedPackageDigests.includes(install.packageDigest);
    const installCurrent =
      installRow.policy_digest === publisher.policyDigest &&
      installRow.policy_event_digest === publisher.eventDigest &&
      installRow.checkpoint_api_version === checkpoint.checkpointApiVersion &&
      Number(installRow.checkpoint_sequence) === checkpoint.sequence &&
      installRow.checkpoint_digest === checkpoint.checkpointDigest &&
      installRow.checkpoint_event_digest === checkpoint.eventDigest;
    const baseSupported =
      publisherCurrent &&
      checkpointCurrent &&
      installCurrent &&
      support.supported &&
      currentImplementationProfile &&
      implementationCandidate !== null &&
      narrowedOperations.length > 0;
    return {
      formRefKey,
      supportKey,
      form,
      publisher,
      checkpoint,
      install,
      support,
      baseSupported,
      heads: [
        expectation("publisher", install.publisherKey, publisher.eventDigest),
        expectation(
          "checkpoint",
          checkpointAuthorityKey(install.publisherKey, install.checkpointApiVersion),
          checkpoint.eventDigest,
        ),
        expectation("install", formRefKey, digest(installRow, "event_digest")),
        expectation("support", supportKey, digest(supportRow, "event_digest")),
      ],
    };
  };

  const readDurableForm = async (
    mode: "definition" | "package",
    formRef: TakoformV1Alpha3FormRef,
    packageDigest: AdmissionDigest,
  ): Promise<InstalledTakoformForm | null> => {
    if (mode === "definition" && packages.readDefinition) {
      const stored = await packages.readDefinition({ packageDigest, formRef });
      return stored
        ? await exactDefinition(stored.manifest, [stored.definition], formRef, packageDigest)
        : null;
    }
    const stored = await packages.read({ packageDigest, formRef });
    return stored
      ? await exactDefinition(stored.manifest, stored.files, formRef, packageDigest)
      : null;
  };

  const activationRead = async (
    base: CurrentBase,
    context: TakoformAuthorityRequestContext,
  ): Promise<ActivationRead> => {
    validateContext(context);
    const durableAudiences = activationAudiences(options.hostId, context);
    const reads = await Promise.all(
      durableAudiences.map(async (audience) => {
        const activationKey = asDigest(
          await canonicalDigest({
            formRefKey: base.formRefKey,
            packageDigest: base.install.packageDigest,
            audience: { kind: audience.kind, value: audience.value },
          }),
        );
        const row = await exactHead(options.sql, ACTIVATION_TABLE, "activation_key", activationKey);
        return {
          row,
          audience,
          activationKey,
        };
      }),
    );
    const facts: AdmissionProjectionActivation[] = [];
    const heads: TakoformAuthorityHeadExpectation[] = [];
    for (const { row, audience, activationKey } of reads) {
      heads.push(
        expectation("activation", activationKey, row ? digest(row, "event_digest") : null),
      );
      if (!row) continue;
      facts.push(
        readActivation(
          row,
          activationKey,
          base.formRefKey,
          base.form.identity.formRef,
          base.install.packageDigest,
          audience,
        ),
      );
    }
    return { facts, heads };
  };

  const projection = async (
    base: CurrentBase,
    operation: "create" | "import" | "update",
    context: TakoformAuthorityRequestContext,
  ): Promise<{
    readonly allowed: boolean;
    readonly current: TakoformAuthorityCurrentHeads;
    readonly activationHeads: readonly TakoformAuthorityHeadExpectation[];
  }> => {
    const activations = await activationRead(base, context);
    const current: TakoformAuthorityCurrentHeads = {
      publisher: base.publisher,
      checkpoint: base.checkpoint,
      install: base.install,
      support: base.support,
      activations: activations.facts,
    };
    const decision = evaluateAdmissionProjection({
      operation,
      context: {
        hostId: options.hostId,
        tenantId: context.tenantId,
        principalId: context.principalId,
        space: context.space,
      },
      formRef: base.form.identity.formRef,
      packageDigest: base.install.packageDigest,
      implementationDigest: base.support.implementationDigest,
      current,
    });
    return { allowed: decision.allowed, current, activationHeads: activations.heads };
  };

  const catalog = async (
    context: TakoformAuthorityRequestContext | TakoformAuthoritySupportContext,
    resolveActivation: boolean,
  ): Promise<TakoformAuthorityCatalog> => {
    validateSupportContext(context);
    const installHeads = await allHeads(options.sql, INSTALL_TABLE, "form_ref_key");
    if (installHeads.length > MAX_CURRENT_FORMS) throw unavailable();
    const seen = new Set<string>();
    for (const row of installHeads) {
      const key = text(row, "form_ref_key");
      if (seen.has(key)) throw unavailable();
      seen.add(key);
    }
    const entries = (
      await mapBounded(installHeads, CATALOG_FORM_CONCURRENCY, async (row) =>
        catalogEntry(context, resolveActivation, row, "definition"),
      )
    ).filter((entry): entry is TakoformAuthorityCatalogEntry => entry !== null);
    entries.sort((left, right) =>
      formKey(left.form.identity.formRef).localeCompare(formKey(right.form.identity.formRef)),
    );
    return {
      forms: entries,
      bindings: bindingsFor(
        entries.filter((entry) => entry.supported).map((entry) => entry.form),
        bindings,
      ),
    };
  };

  /**
   * Projects only the package(s) that can answer one exact support query. Form
   * selectors resolve through the compiled candidate's canonical key, while
   * interface/binding selectors use a bounded current-head scan and then open
   * package bytes only for candidates that can provide the requested contract.
   */
  const projectSupportLookup = async (
    context: TakoformAuthoritySupportContext,
    query: TakoformAuthoritySupportLookup,
  ): Promise<TakoformAuthoritySupportProjection> => {
    validateSupportContext(context);
    let installHeads: readonly Row[];
    let candidateKeys: ReadonlySet<string> | null = null;
    if (query.target === "form") {
      if (
        !isFormApiVersion(query.apiVersion) ||
        !isKind(query.kind) ||
        !isDefinitionVersion(query.definitionVersion)
      ) {
        return { forms: [], bindings: [] };
      }
      // The compiled candidate registry already refuses two schema digests
      // for one Form definition. Use that sole exact identity to reach the
      // indexed install-head lookup; a durable row for another schema digest
      // is necessarily not executable by this Host and must not make this
      // support probe scan the entire append-only ledger.
      const candidate = [...candidates.values()].find(
        (form) =>
          form.identity.formRef.apiVersion === query.apiVersion &&
          form.identity.formRef.kind === query.kind &&
          form.identity.formRef.definitionVersion === query.definitionVersion,
      );
      if (!candidate) return { forms: [], bindings: [] };
      const candidateFormRefKey = asDigest(await canonicalDigest(candidate.identity.formRef));
      const installHead = await exactHead(
        options.sql,
        INSTALL_TABLE,
        "form_ref_key",
        candidateFormRefKey,
      );
      installHeads = installHead ? [installHead] : [];
    } else {
      installHeads = await allHeads(options.sql, INSTALL_TABLE, "form_ref_key");
      if (installHeads.length > MAX_CURRENT_FORMS) throw unavailable();
      candidateKeys = new Set(
        [...candidates.values()]
          .filter((form) => formMatchesSupportLookup(form, query, bindings))
          .map((form) => formKey(form.identity.formRef)),
      );
      if (candidateKeys.size === 0) return { forms: [], bindings: [] };
      assertUniqueInstallHeadKeys(installHeads);
    }

    const entries = (
      await mapBounded(installHeads, CATALOG_FORM_CONCURRENCY, async (row) => {
        if (candidateKeys !== null) {
          const key = formKey(parseFormRef(row.form_ref_json));
          if (!candidateKeys.has(key)) return null;
        }
        return catalogEntry(context, false, row, "definition");
      })
    ).filter((entry): entry is TakoformAuthorityCatalogEntry => entry !== null);

    const supported = entries.filter((entry) => {
      if (!entry.supported) return false;
      return query.target === "form" || formMatchesSupportLookup(entry.form, query, bindings);
    });
    return {
      forms: entries,
      bindings: bindingsFor(
        supported.map((entry) => entry.form),
        bindings,
      ),
    };
  };

  const catalogEntry = async (
    context: TakoformAuthorityRequestContext | TakoformAuthoritySupportContext,
    resolveActivation: boolean,
    row: Row,
    readMode: "definition" | "package",
  ): Promise<TakoformAuthorityCatalogEntry | null> => {
    if (text(row, "event_type") === "uninstall") return null;
    const parsedRef = parseFormRef(row.form_ref_json);
    const base = await currentBase(parsedRef, "null", row, readMode);
    if (!base) return null;
    const technical = base.baseSupported
      ? await options.technicalAvailability.resolve({
          tenantId: context.tenantId,
          principalId: context.principalId,
          form: base.form,
        })
      : { executable: false, activated: false, availableToPrincipal: false };
    let activationAllowed = false;
    let activationHeads: readonly TakoformAuthorityHeadExpectation[] = [];
    if (resolveActivation) {
      const operation = base.form.operations.find((value) => MUTATION_OPERATIONS.has(value));
      if (operation === "create" || operation === "import" || operation === "update") {
        if (!("space" in context)) throw unavailable();
        const decision = await projection(base, operation, context);
        activationAllowed = decision.allowed;
        activationHeads = decision.activationHeads;
      }
    }
    const heads = [...base.heads, ...activationHeads];
    const headDigest = asDigest(
      await canonicalDigest({
        version: "takoserver.takoform-authority-catalog@v1",
        formRef: base.form.identity.formRef,
        packageDigest: base.install.packageDigest,
        implementationDigest: base.support.implementationDigest,
        heads,
      }),
    );
    return {
      form: structuredClone(base.form),
      supported: base.baseSupported && technical.executable,
      availability: {
        executable: base.baseSupported && technical.executable,
        activated:
          resolveActivation && activationAllowed && technical.activated && base.baseSupported,
        availableToPrincipal:
          resolveActivation &&
          activationAllowed &&
          technical.availableToPrincipal &&
          base.baseSupported,
      },
      headDigest,
    };
  };

  return {
    catalog(context) {
      return execute(() => catalog(context, true));
    },

    supportCatalog(context) {
      return execute(() => catalog(context, false));
    },

    lookupSupport(context, query) {
      return execute(() => projectSupportLookup(context, query));
    },

    authorizeMutation(input) {
      return execute(async () => {
        validateContext(input.context);
        const base = await currentBase(input.formRef, "error", undefined, "package");
        if (!base) throw unavailable();
        if (!base.baseSupported) throw unavailable();
        const decision = await projection(base, input.operation, input.context);
        if (!decision.allowed) throw unavailable();
        const technical = await options.technicalAvailability.resolve({
          tenantId: input.context.tenantId,
          principalId: input.context.principalId,
          form: base.form,
        });
        if (!technical.executable) throw unavailable();
        if (!technical.activated || !technical.availableToPrincipal) {
          throw new TakoformHostError("policy_denied", 403);
        }
        const purgeHead = await exactPackageHead(
          options.sql,
          PURGE_TABLE,
          base.formRefKey,
          base.install.packageDigest,
        );
        if (purgeHead) throw unavailable();
        const fence = await makeFence(
          "mutation",
          base.install.packageDigest,
          base.support.implementationDigest,
          [
            ...base.heads,
            ...decision.activationHeads,
            expectation("purge", purgeKey(base.formRefKey, base.install.packageDigest), null),
          ],
        );
        return {
          form: structuredClone(base.form),
          packageDigest: base.install.packageDigest,
          implementationDigest: base.support.implementationDigest,
          current: decision.current,
          fence,
        };
      });
    },

    authorizeRetained(input) {
      return execute(async () => {
        validateContext(input.context);
        const identity = input.resource.form;
        if (
          !isSha256Digest(identity.packageDigest) ||
          !isSha256Digest(identity.implementationDigest)
        ) {
          throw unavailable();
        }
        if (
          input.resource.metadata.space !== input.context.space ||
          input.resource.metadata.uid.length < 3
        ) {
          throw new TakoformHostError("resource_not_found", 404);
        }
        const formRefKey = asDigest(await canonicalDigest(identity.formRef));
        const historyRows = await options.sql.query(
          `SELECT * FROM ${INSTALL_TABLE}
           WHERE form_ref_key = ? AND package_digest = ?
           ORDER BY event_at, id`,
          [formRefKey, identity.packageDigest],
        );
        if (historyRows.length === 0 || historyRows.length > 128) throw unavailable();
        const installs = historyRows.map((row) => readInstall(row, formRefKey, identity.formRef));
        const sourceIndex = installs.findIndex(
          (install) =>
            (install.eventType === "install" || install.eventType === "replace") &&
            (install.implementationDigest === undefined ||
              install.implementationDigest === identity.implementationDigest),
        );
        if (sourceIndex < 0) throw unavailable();
        const sourceRow = historyRows[sourceIndex];
        if (!sourceRow) throw unavailable();
        const purgeHead = await exactPackageHead(
          options.sql,
          PURGE_TABLE,
          formRefKey,
          identity.packageDigest,
        );
        if (purgeHead && text(purgeHead, "event_type") !== "purged") throw unavailable();
        const stored = await packages.read({
          packageDigest: identity.packageDigest,
          formRef: identity.formRef,
        });
        const durableForm = stored
          ? await exactDefinition(
              stored.manifest,
              stored.files,
              identity.formRef,
              identity.packageDigest,
            )
          : null;
        if (!stored || purgeHead || !durableForm) {
          throw unavailable();
        }
        const retention: AdmissionProjectionRetention = {
          formRef: structuredClone(identity.formRef),
          packageDigest: identity.packageDigest,
          implementationDigest: identity.implementationDigest,
          retained: true,
        };
        const currentInstallRow = await exactHead(
          options.sql,
          INSTALL_TABLE,
          "form_ref_key",
          formRefKey,
        );
        const currentInstall = currentInstallRow
          ? readInstall(currentInstallRow, formRefKey, identity.formRef)
          : null;
        const history: AdmissionProjectionHistory = { installs };
        const decision = evaluateAdmissionProjection({
          operation: input.operation,
          context: {
            hostId: options.hostId,
            tenantId: input.context.tenantId,
            principalId: input.context.principalId,
            space: input.context.space,
          },
          formRef: identity.formRef,
          packageDigest: identity.packageDigest,
          implementationDigest: identity.implementationDigest,
          current: { install: currentInstall, retentions: [retention] },
          history,
          resource: {
            resourceUid: input.resource.metadata.uid,
            tenantId: input.context.tenantId,
            space: input.resource.metadata.space,
            formRef: identity.formRef,
            packageDigest: identity.packageDigest,
            implementationDigest: identity.implementationDigest,
          },
        });
        if (!decision.allowed) throw unavailable();
        const compiledCandidate = exactInstalledForm(identity.formRef, candidates);
        const form: InstalledTakoformForm = {
          ...structuredClone(
            compiledCandidate?.identity.packageDigest === identity.packageDigest
              ? compiledCandidate
              : durableForm,
          ),
          identity: {
            formRef: structuredClone(identity.formRef),
            packageDigest: identity.packageDigest,
            implementationDigest: identity.implementationDigest,
          },
        };
        const fence = await makeFence(
          "retained-cleanup",
          identity.packageDigest,
          identity.implementationDigest,
          [
            expectation(
              "install-event",
              digest(sourceRow, "event_digest"),
              digest(sourceRow, "event_digest"),
            ),
            expectation("purge", purgeKey(formRefKey, identity.packageDigest), null),
          ],
        );
        return {
          form,
          packageDigest: identity.packageDigest,
          implementationDigest: identity.implementationDigest,
          history,
          retention,
          fence,
        };
      });
    },
  };
}

function supportProfileMatchesPublicWorker(
  row: Row,
  implementationDigest: AdmissionDigest,
  currentImplementationDigest: AdmissionDigest | undefined,
): boolean {
  if (currentImplementationDigest === undefined) return true;
  const profile = parseJson(row.profile_json);
  if (!isJsonObject(profile)) return false;
  const semanticMatch =
    profile.implementationDigest === implementationDigest &&
    implementationDigest === currentImplementationDigest;
  if (!semanticMatch) return false;
  if (profile.kind === "takoserver.form-support@v2") {
    return exactKeys(profile, ["implementationDigest", "kind"]);
  }
  return (
    profile.kind === "takoserver.form-support@v1" &&
    exactKeys(profile, [
      "capabilityDigest",
      "implementationDigest",
      "kind",
      "publicWorkerVersionId",
      "workerArtifactDigest",
    ]) &&
    isSha256Digest(profile.workerArtifactDigest) &&
    isSha256Digest(profile.capabilityDigest) &&
    typeof profile.publicWorkerVersionId === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(
      profile.publicWorkerVersionId,
    )
  );
}

function exactKeys(value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean {
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}

/** Canonical durable audience values used by the private writer/operator tool. */
export function takoformActivationAudience(
  kind: "host" | "tenant" | "space" | "principal",
  input: {
    readonly hostId?: string;
    readonly tenantId?: string;
    readonly space?: string;
    readonly principalId?: string;
  },
): { readonly kind: typeof kind; readonly value: string } {
  switch (kind) {
    case "host":
      requireIdentity(input.hostId, "host id");
      return { kind, value: input.hostId };
    case "tenant":
      requireIdentity(input.tenantId, "tenant id");
      return { kind, value: input.tenantId };
    case "space":
      requireIdentity(input.tenantId, "tenant id");
      requireIdentity(input.space, "space");
      return {
        kind,
        value: boundedAudience(canonicalJson({ tenantId: input.tenantId, space: input.space })),
      };
    case "principal":
      requireIdentity(input.tenantId, "tenant id");
      requireIdentity(input.principalId, "principal id");
      return {
        kind,
        value: boundedAudience(
          canonicalJson({ tenantId: input.tenantId, principalId: input.principalId }),
        ),
      };
  }
}

function activationAudiences(
  hostId: string,
  context: TakoformAuthorityRequestContext,
): readonly {
  readonly kind: "host" | "tenant" | "space" | "principal";
  readonly value: string;
  readonly projection:
    | { readonly kind: "host"; readonly hostId: string }
    | { readonly kind: "tenant"; readonly tenantId: string }
    | { readonly kind: "space"; readonly tenantId: string; readonly space: string }
    | { readonly kind: "principal"; readonly tenantId: string; readonly principalId: string };
}[] {
  return [
    {
      ...takoformActivationAudience("host", { hostId }),
      projection: { kind: "host", hostId },
    },
    {
      ...takoformActivationAudience("tenant", { tenantId: context.tenantId }),
      projection: { kind: "tenant", tenantId: context.tenantId },
    },
    {
      ...takoformActivationAudience("space", {
        tenantId: context.tenantId,
        space: context.space,
      }),
      projection: { kind: "space", tenantId: context.tenantId, space: context.space },
    },
    {
      ...takoformActivationAudience("principal", {
        tenantId: context.tenantId,
        principalId: context.principalId,
      }),
      projection: {
        kind: "principal",
        tenantId: context.tenantId,
        principalId: context.principalId,
      },
    },
  ];
}

function readPublisher(row: Row, publisherKey: string): AdmissionProjectionPublisher {
  if (text(row, "publisher_key") !== publisherKey) throw unavailable();
  const eventType = text(row, "event_type");
  if (eventType !== "allow" && eventType !== "rotate" && eventType !== "deny") {
    throw unavailable();
  }
  return {
    publisherKey,
    eventType,
    policyDigest: digest(row, "policy_digest"),
    eventDigest: digest(row, "event_digest"),
  };
}

function readCheckpoint(row: Row, publisherKey: string): AdmissionProjectionCheckpoint {
  if (text(row, "publisher_key") !== publisherKey) throw unavailable();
  const checkpointApiVersion = checkpointProfile(row, "checkpoint_api_version");
  const sequence = integer(row, "sequence");
  const checkpointDigest = digest(row, "checkpoint_digest");
  const entriesDigest = digest(row, "entries_digest");
  const revoked = parseArray(row.revoked_package_digests_json);
  if (revoked.some((value) => !isSha256Digest(value))) throw unavailable();
  if (new Set(revoked).size !== revoked.length) throw unavailable();
  const previous = row.previous_checkpoint_digest;
  if (
    (checkpointApiVersion === TAKOFORM_REVOCATION_V1 &&
      ((sequence === 0 &&
        (checkpointDigest !== TAKOFORM_REVOCATION_V1_GENESIS_DIGEST ||
          entriesDigest !== TAKOFORM_REVOCATION_V1_EMPTY_ENTRIES_DIGEST ||
          previous !== null ||
          revoked.length !== 0)) ||
        (sequence > 0 && !isSha256Digest(previous)) ||
        sequence < 0)) ||
    (checkpointApiVersion === TAKOFORM_REVOCATION_V1ALPHA1 &&
      (sequence < 1 ||
        (sequence === 1 && previous !== null && previous !== ADMISSION_GENESIS_DIGEST) ||
        (sequence > 1 && !isSha256Digest(previous))))
  ) {
    throw unavailable();
  }
  return {
    publisherKey,
    checkpointApiVersion,
    policyDigest: digest(row, "policy_digest"),
    policyEventDigest: digest(row, "policy_event_digest"),
    sequence,
    checkpointDigest,
    entriesDigest,
    eventDigest: digest(row, "event_digest"),
    verified: true,
    stale: false,
    revokedPackageDigests: revoked as AdmissionDigest[],
  };
}

function readInstall(
  row: Row,
  expectedKey: AdmissionDigest,
  expectedRef: TakoformV1Alpha3FormRef,
): AdmissionProjectionInstall {
  if (text(row, "form_ref_key") !== expectedKey) throw unavailable();
  const formRef = parseFormRef(row.form_ref_json);
  if (
    !sameFormRef(formRef, expectedRef) ||
    text(row, "form_api_version") !== formRef.apiVersion ||
    text(row, "form_kind") !== formRef.kind ||
    text(row, "form_definition_version") !== formRef.definitionVersion ||
    digest(row, "schema_digest") !== formRef.schemaDigest
  ) {
    throw unavailable();
  }
  const eventType = text(row, "event_type");
  if (eventType !== "install" && eventType !== "replace" && eventType !== "uninstall") {
    throw unavailable();
  }
  const implementation = row.implementation_digest;
  return {
    formRef,
    packageDigest: digest(row, "package_digest"),
    publisherKey: text(row, "publisher_key"),
    checkpointApiVersion: checkpointProfile(row, "checkpoint_api_version"),
    eventType,
    ...(implementation === null || implementation === undefined
      ? {}
      : { implementationDigest: digest(row, "implementation_digest") }),
  };
}

function readSupport(
  row: Row,
  expectedSupportKey: AdmissionDigest,
  expectedFormRefKey: AdmissionDigest,
  expectedRef: TakoformV1Alpha3FormRef,
  expectedPackage: AdmissionDigest,
): AdmissionProjectionSupport {
  if (
    text(row, "support_key") !== expectedSupportKey ||
    text(row, "form_ref_key") !== expectedFormRefKey ||
    digest(row, "package_digest") !== expectedPackage ||
    !sameFormRef(parseFormRef(row.form_ref_json), expectedRef)
  ) {
    throw unavailable();
  }
  const supported = booleanInteger(row, "supported");
  const operations = parseArray(row.operations_json);
  if (
    operations.some(
      (value) => typeof value !== "string" || !ALL_OPERATIONS.has(value as TakoformOperation),
    ) ||
    new Set(operations).size !== operations.length
  ) {
    throw unavailable();
  }
  return {
    formRef: structuredClone(expectedRef),
    packageDigest: expectedPackage,
    implementationDigest: digest(row, "implementation_digest"),
    supported,
    operations: operations as TakoformOperation[],
  };
}

function readActivation(
  row: Row,
  expectedActivationKey: AdmissionDigest,
  expectedFormRefKey: AdmissionDigest,
  expectedRef: TakoformV1Alpha3FormRef,
  expectedPackage: AdmissionDigest,
  expectedAudience: ReturnType<typeof activationAudiences>[number],
): AdmissionProjectionActivation {
  if (
    text(row, "activation_key") !== expectedActivationKey ||
    text(row, "form_ref_key") !== expectedFormRefKey ||
    digest(row, "package_digest") !== expectedPackage ||
    text(row, "audience_kind") !== expectedAudience.kind ||
    text(row, "audience_value") !== expectedAudience.value ||
    !sameFormRef(parseFormRef(row.form_ref_json), expectedRef)
  ) {
    throw unavailable();
  }
  return {
    formRef: structuredClone(expectedRef),
    packageDigest: expectedPackage,
    implementationDigest: digest(row, "implementation_digest"),
    audience: structuredClone(expectedAudience.projection),
    active: booleanInteger(row, "active"),
  };
}

async function validateEvidencePins(input: {
  readonly publisherRow: Row;
  readonly checkpointRow: Row;
  readonly installRow: Row;
  readonly publisher: AdmissionProjectionPublisher;
  readonly checkpoint: AdmissionProjectionCheckpoint;
  readonly install: AdmissionProjectionInstall;
}): Promise<void> {
  const { publisherRow, checkpointRow, installRow, publisher, checkpoint, install } = input;
  const group = formGroupFromApiVersion(install.formRef.apiVersion);
  const sourceCommit = text(publisherRow, "source_commit");
  const workflowCommit = text(publisherRow, "workflow_commit");
  const buildConfigCommit = text(publisherRow, "build_config_commit");
  const report = parseJson(installRow.admission_report_json);
  if (
    !isJsonObject(report) ||
    (await canonicalDigest(report)) !== digest(installRow, "admission_report_digest")
  ) {
    throw unavailable();
  }
  const reportSource = report.source;
  const reportRevocation = report.revocation;
  if (!isJsonObject(reportSource) || !isJsonObject(reportRevocation)) throw unavailable();
  if (
    !group ||
    !rawGitCommit(sourceCommit) ||
    !rawGitCommit(workflowCommit) ||
    !rawGitCommit(buildConfigCommit) ||
    reportSource.sourceCommit !== sourceCommit ||
    reportSource.workflowCommit !== workflowCommit ||
    reportSource.buildConfigCommit !== buildConfigCommit ||
    reportRevocation.checkpointApiVersion !== checkpoint.checkpointApiVersion ||
    reportRevocation.sequence !== checkpoint.sequence ||
    reportRevocation.checkpointDigest !== checkpoint.checkpointDigest ||
    reportRevocation.entriesDigest !== checkpoint.entriesDigest ||
    checkpoint.policyDigest !== publisher.policyDigest ||
    checkpoint.policyEventDigest !== publisher.eventDigest ||
    digest(installRow, "policy_digest") !== publisher.policyDigest ||
    digest(installRow, "policy_event_digest") !== publisher.eventDigest ||
    checkpointProfile(installRow, "checkpoint_api_version") !== checkpoint.checkpointApiVersion ||
    install.checkpointApiVersion !== checkpoint.checkpointApiVersion ||
    integer(installRow, "checkpoint_sequence") !== checkpoint.sequence ||
    digest(installRow, "checkpoint_digest") !== checkpoint.checkpointDigest ||
    digest(installRow, "checkpoint_event_digest") !== checkpoint.eventDigest ||
    text(installRow, "source_commit") !== sourceCommit ||
    text(installRow, "workflow_commit") !== workflowCommit ||
    text(installRow, "build_config_commit") !== buildConfigCommit ||
    text(installRow, "repository_identifier") !== text(publisherRow, "repository_identifier") ||
    text(installRow, "owner_identifier") !== text(publisherRow, "owner_identifier") ||
    text(installRow, "namespace_group") !== group ||
    text(installRow, "namespace_group") !== text(publisherRow, "namespace_group") ||
    digest(installRow, "namespace_grant_digest") !==
      digest(publisherRow, "namespace_grant_digest") ||
    digest(checkpointRow, "policy_digest") !== publisher.policyDigest ||
    digest(checkpointRow, "policy_event_digest") !== publisher.eventDigest ||
    checkpointProfile(checkpointRow, "checkpoint_api_version") !== checkpoint.checkpointApiVersion
  ) {
    throw unavailable();
  }
}

async function exactDefinition(
  manifest: Record<string, unknown>,
  files: readonly { readonly path: string; readonly bytes: Uint8Array }[],
  formRef: TakoformV1Alpha3FormRef,
  packageDigest: AdmissionDigest,
): Promise<InstalledTakoformForm | null> {
  const definitionPath = manifest.definitionPath;
  if (typeof definitionPath !== "string") return null;
  const file = files.find((candidate) => candidate.path === definitionPath);
  if (!file) return null;
  let definition: unknown;
  try {
    definition = JSON.parse(new TextDecoder().decode(file.bytes));
  } catch {
    return null;
  }
  return await installedFormFromDefinition(definition, formRef, packageDigest);
}

async function exactHead(
  sql: Sql,
  table: string,
  keyColumn: string,
  key: string,
): Promise<Row | null> {
  const rows = await sql.query(
    `SELECT * FROM ${table} AS current
     WHERE current.${keyColumn} = ?
       AND NOT EXISTS (
         SELECT 1 FROM ${table} AS successor
         WHERE successor.${keyColumn} = current.${keyColumn}
           AND successor.predecessor_digest = current.event_digest
       )
     LIMIT 2`,
    [key],
  );
  if (rows.length > 1) throw unavailable();
  return rows[0] ?? null;
}

async function exactCheckpointHead(
  sql: Sql,
  publisherKey: string,
  checkpointApiVersion: TakoformRevocationCheckpointApiVersion,
): Promise<Row | null> {
  const rows = await sql.query(
    `SELECT * FROM ${CHECKPOINT_TABLE} AS current
     WHERE current.publisher_key = ?
       AND current.checkpoint_api_version = ?
       AND NOT EXISTS (
         SELECT 1 FROM ${CHECKPOINT_TABLE} AS successor
         WHERE successor.publisher_key = current.publisher_key
           AND successor.checkpoint_api_version = current.checkpoint_api_version
           AND successor.predecessor_digest = current.event_digest
       )
     LIMIT 2`,
    [publisherKey, checkpointApiVersion],
  );
  if (rows.length > 1) throw unavailable();
  return rows[0] ?? null;
}

async function allHeads(sql: Sql, table: string, keyColumn: string): Promise<readonly Row[]> {
  const rows = await sql.query(
    `SELECT * FROM ${table} AS current
     WHERE NOT EXISTS (
       SELECT 1 FROM ${table} AS successor
       WHERE successor.${keyColumn} = current.${keyColumn}
         AND successor.predecessor_digest = current.event_digest
     )
     ORDER BY current.${keyColumn}, current.event_at, current.id
     LIMIT ?`,
    [MAX_CURRENT_FORMS + 1],
  );
  return rows;
}

function assertUniqueInstallHeadKeys(rows: readonly Row[]): void {
  const keys = new Set<string>();
  for (const row of rows) {
    const key = text(row, "form_ref_key");
    if (keys.has(key)) throw unavailable();
    keys.add(key);
  }
}

function formMatchesSupportLookup(
  form: InstalledTakoformForm,
  query: Exclude<TakoformAuthoritySupportLookup, { readonly target: "form" }>,
  bindings: BindingRegistry,
): boolean {
  if (query.target === "binding") {
    return (form.acceptedBindings ?? []).some(
      (reference) => reference.name === query.name && reference.version === query.version,
    );
  }
  if (
    (form.providedInterfaces ?? []).some(
      (reference) => reference.name === query.name && reference.version === query.version,
    )
  ) {
    return true;
  }
  return (form.acceptedBindings ?? []).some((accepted) =>
    [...bindings.values()].some(
      (binding) =>
        binding.bindingRef.name === accepted.name &&
        binding.bindingRef.version === accepted.version &&
        binding.targetInterface.name === query.name &&
        binding.targetInterface.version === query.version,
    ),
  );
}

async function mapBounded<T, R>(
  input: readonly T[],
  concurrency: number,
  map: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (input.length === 0) return [];
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
    throw new TypeError("concurrency must be a positive integer");
  }
  const output = Array<R>(input.length);
  let next = 0;
  let stopped = false;
  let failed = false;
  let firstError: unknown;
  const worker = async (): Promise<void> => {
    while (true) {
      if (stopped) return;
      const index = next;
      next += 1;
      if (index >= input.length) return;
      const value = input[index];
      if (value === undefined) return;
      try {
        output[index] = await map(value, index);
      } catch (error) {
        if (!failed) {
          failed = true;
          firstError = error;
        }
        stopped = true;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, input.length) }, () => worker()));
  if (failed) throw firstError;
  return output;
}

async function exactPackageHead(
  sql: Sql,
  table: typeof PURGE_TABLE,
  formRefKey: AdmissionDigest,
  packageDigest: AdmissionDigest,
): Promise<Row | null> {
  const rows = await sql.query(
    `SELECT * FROM ${table} AS current
     WHERE current.form_ref_key = ? AND current.package_digest = ?
       AND NOT EXISTS (
         SELECT 1 FROM ${table} AS successor
         WHERE successor.form_ref_key = current.form_ref_key
           AND successor.package_digest = current.package_digest
           AND successor.predecessor_digest = current.event_digest
       )
     LIMIT 2`,
    [formRefKey, packageDigest],
  );
  if (rows.length > 1) throw unavailable();
  return rows[0] ?? null;
}

async function makeFence(
  mode: TakoformAuthorityFence["mode"],
  packageDigest: AdmissionDigest,
  implementationDigest: AdmissionDigest,
  heads: readonly TakoformAuthorityHeadExpectation[],
): Promise<TakoformAuthorityFence> {
  const normalized = [...heads].sort((left, right) =>
    `${left.kind}\u0000${left.key}`.localeCompare(`${right.kind}\u0000${right.key}`),
  );
  if (
    new Set(normalized.map((head) => `${head.kind}\u0000${head.key}`)).size !== normalized.length
  ) {
    throw unavailable();
  }
  const headDigest = asDigest(
    await canonicalDigest({
      version: "takoserver.takoform-authority-fence@v1",
      mode,
      packageDigest,
      implementationDigest,
      heads: normalized,
    }),
  );
  return {
    version: "takoserver.takoform-authority-fence@v1",
    mode,
    packageDigest,
    implementationDigest,
    headDigest,
    heads: normalized,
  };
}

function bindingsFor(
  forms: readonly InstalledTakoformForm[],
  bindings: BindingRegistry,
): readonly InstalledTakoformBinding[] {
  const accepted = new Set(
    forms.flatMap((form) =>
      (form.acceptedBindings ?? []).map(
        (binding) =>
          `${binding.apiVersion}\u0000${binding.name}\u0000${binding.version}\u0000${binding.schemaDigest}`,
      ),
    ),
  );
  return [...bindings.values()]
    .filter((binding) =>
      accepted.has(
        `${binding.bindingRef.apiVersion}\u0000${binding.bindingRef.name}\u0000${binding.bindingRef.version}\u0000${binding.bindingRef.schemaDigest}`,
      ),
    )
    .map((binding) => structuredClone(binding));
}

function parseFormRef(value: unknown): TakoformV1Alpha3FormRef {
  const parsed = parseJson(value);
  if (!isJsonObject(parsed)) throw unavailable();
  const keys = Object.keys(parsed).sort();
  if (
    keys.join("|") !== "apiVersion|definitionVersion|kind|schemaDigest" ||
    typeof parsed.apiVersion !== "string" ||
    typeof parsed.kind !== "string" ||
    typeof parsed.definitionVersion !== "string" ||
    !isSha256Digest(parsed.schemaDigest)
  ) {
    throw unavailable();
  }
  const formRef = parsed as unknown as TakoformV1Alpha3FormRef;
  try {
    installedForms([
      {
        identity: { formRef },
        desiredSchema: {},
        operations: [],
      },
    ]);
  } catch {
    throw unavailable();
  }
  return structuredClone(formRef);
}

function parseArray(value: unknown): unknown[] {
  const parsed = parseJson(value);
  if (!Array.isArray(parsed) || parsed.length > 128) throw unavailable();
  return parsed;
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string") throw unavailable();
  try {
    return JSON.parse(value);
  } catch {
    throw unavailable();
  }
}

function expectation(
  kind: TakoformAuthorityHeadKind,
  key: string,
  eventDigest: AdmissionDigest | null,
): TakoformAuthorityHeadExpectation {
  if (key.length === 0 || key.length > 512) throw unavailable();
  return { kind, key, eventDigest };
}

function purgeKey(formRefKey: AdmissionDigest, packageDigest: AdmissionDigest): string {
  return `${formRefKey}\u0000${packageDigest}`;
}

function checkpointAuthorityKey(
  publisherKey: string,
  checkpointApiVersion: TakoformRevocationCheckpointApiVersion,
): string {
  return canonicalJson({ publisherKey, checkpointApiVersion });
}

function checkpointProfile(row: Row, column: string): TakoformRevocationCheckpointApiVersion {
  const value = text(row, column);
  if (value !== TAKOFORM_REVOCATION_V1 && value !== TAKOFORM_REVOCATION_V1ALPHA1) {
    throw unavailable();
  }
  return value;
}

function rawGitCommit(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{40}$/u.test(value);
}

function text(row: Row, column: string): string {
  const value = row[column];
  if (typeof value !== "string" || value.length === 0 || value.length > 4096) {
    throw unavailable();
  }
  return value;
}

function digest(row: Row, column: string): AdmissionDigest {
  const value = row[column];
  if (!isSha256Digest(value)) throw unavailable();
  return value;
}

function asDigest(value: string): AdmissionDigest {
  if (!isSha256Digest(value)) throw unavailable();
  return value;
}

function integer(row: Row, column: string): number {
  const value = row[column];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) throw unavailable();
  return value;
}

function booleanInteger(row: Row, column: string): boolean {
  const value = integer(row, column);
  if (value !== 0 && value !== 1) throw unavailable();
  return value === 1;
}

function validateContext(context: TakoformAuthorityRequestContext): void {
  validateSupportContext(context);
  requireIdentity(context.space, "space");
}

function validateSupportContext(context: TakoformAuthoritySupportContext): void {
  if (!context || typeof context !== "object") throw unavailable();
  requireIdentity(context.tenantId, "tenant id");
  requireIdentity(context.principalId, "principal id");
}

function requireIdentity(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 255) {
    throw new TypeError(`invalid ${label}`);
  }
}

function boundedAudience(value: string): string {
  if (value.length === 0 || value.length > 255)
    throw new TypeError("activation audience is too long");
  return value;
}

function unavailable(): TakoformHostError {
  return new TakoformHostError("form_unavailable", 503);
}

function unavailablePackageReader(): FormPackageReader {
  return {
    async read(): Promise<null> {
      throw unavailable();
    },
  };
}
