import type { ResourceSummary } from "../api.ts";
import { ApiError } from "../api.ts";
import { type Child, h, live, text } from "../dom.ts";
import { formLabel } from "../forms.ts";
import { tr } from "../i18n.ts";
import { resource } from "../reactive.ts";
import { health, phaseLabel } from "../resource-state.ts";
import { linkProps, resourcePath, route } from "../router.ts";
import { api, currentOrganization } from "../state.ts";
import { badge, card, copyable, empty, ICON, icon, jsonBlock, whenReady } from "../ui.ts";
import { deleteResource, updateResource } from "./create-resource.ts";

export interface SpecReference {
  /** Where the spec names it: `bundle`, `sqliteBindings · DB`, `versions #1 · workerVersion`. */
  readonly path: string;
  readonly uid: string;
}

/**
 * Every Resource a spec names, in the order it names them. A v2 reference is
 * an object holding exactly one `resourceUid`; a Binding entry is labelled by
 * its own `name`, which is how the Worker reaches it.
 */
export function specReferences(spec: unknown): SpecReference[] {
  const found: SpecReference[] = [];
  const walk = (value: unknown, path: readonly string[]): void => {
    if (Array.isArray(value)) {
      value.forEach((entry, index) => {
        const named =
          entry &&
          typeof entry === "object" &&
          typeof (entry as { name?: unknown }).name === "string"
            ? (entry as { name: string }).name
            : `#${index + 1}`;
        walk(entry, [...path, named]);
      });
      return;
    }
    if (!value || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record);
    if (keys.length === 1 && keys[0] === "resourceUid" && typeof record.resourceUid === "string") {
      // A Binding's `resource` key adds nothing its name has not said.
      const shown = path.at(-1) === "resource" && path.length > 1 ? path.slice(0, -1) : path;
      found.push({ path: shown.join(" · "), uid: record.resourceUid });
      return;
    }
    for (const key of keys) walk(record[key], [...path, key]);
  };
  walk(spec, []);
  return found;
}

/** The https URL a Resource reports for itself, such as a WorkerEndpoint's. */
export function publishedUrl(output: unknown): string | null {
  const url = output && typeof output === "object" ? (output as { url?: unknown }).url : null;
  if (typeof url !== "string") return null;
  try {
    return new URL(url).protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

/** The v2 address is the durable UID, never a reconstructed kind/name tuple. */
export function resourceDetailPage(organizationId: string, uid: string): Child {
  const isCurrent = (): boolean =>
    currentOrganization()?.id === organizationId &&
    route().segments.length === 2 &&
    route().segments[0] === "resources" &&
    route().segments[1] === uid;
  const page = resource(async () => {
    try {
      const found = await api.resource(organizationId, uid);
      return isCurrent() ? found : null;
    } catch (error) {
      if (error instanceof ApiError && (error.status === 404 || error.status === 410)) return null;
      throw error;
    }
  });

  return h(
    "div",
    { class: "page" },
    live(() =>
      whenReady(
        page.get(),
        (found) => {
          if (!isCurrent()) return null;
          return found
            ? body(found, organizationId, page.reload)
            : card(
                null,
                empty(
                  tr("リソースがありません", "No such resource"),
                  tr(
                    "この組織に該当するUIDはありません。",
                    "There is no Resource with this UID in this organization.",
                  ),
                  h(
                    "a",
                    { class: "btn", ...linkProps("/resources") },
                    tr("リソース一覧へ戻る", "Back to resources"),
                  ),
                ),
              );
        },
        { retry: page.reload },
      ),
    ),
  );
}

function body(found: ResourceSummary, organizationId: string, reload: () => void): Child {
  const state = health(found);
  const url = publishedUrl(found.output);
  const references = specReferences(found.spec);
  return h(
    "div",
    { style: { display: "grid", gap: "18px" } },
    h(
      "div",
      { class: "head" },
      h(
        "div",
        { class: "head__text" },
        h(
          "div",
          { class: "dim" },
          h("a", { ...linkProps("/resources") }, tr("リソース", "Resources")),
          text(" / "),
          found.space,
        ),
        h(
          "h1",
          null,
          // The name is the page title; .mono alone would shrink it to body size.
          h(
            "span",
            { class: "mono", style: { fontSize: "inherit", overflowWrap: "anywhere" } },
            found.name,
          ),
          text(" "),
          badge(phaseLabel(state.phase), state.tone, true),
        ),
        h("p", { class: "mono", style: { overflowWrap: "anywhere" } }, found.form),
        url
          ? h(
              "p",
              { class: "published" },
              h(
                "a",
                { href: url, target: "_blank", rel: "noopener noreferrer" },
                url,
                h("span", { "aria-hidden": "true" }, " ↗"),
              ),
            )
          : null,
      ),
      h(
        "div",
        { class: "toolbar" },
        h(
          "button",
          { class: "btn", type: "button", onClick: reload },
          icon(ICON.refresh, 14),
          text(tr("再読み込み", "Reload")),
        ),
        h(
          "button",
          { class: "btn", type: "button", onClick: () => updateResource(organizationId, found) },
          tr("更新", "Update"),
        ),
        h(
          "button",
          {
            class: "btn btn--danger",
            type: "button",
            onClick: () => deleteResource(organizationId, found),
          },
          tr("削除", "Delete"),
        ),
      ),
    ),
    state.stale
      ? h(
          "div",
          { class: "notice notice--warn" },
          tr(
            "最新の宣言はまだ観測されていません。",
            "The latest declaration has not yet been observed.",
          ),
        )
      : null,
    state.phase === "NotReady"
      ? h(
          "div",
          { class: "notice notice--warn" },
          tr("最新の観測でReadyではありません。", "The latest observation reports not ready."),
        )
      : null,
    references.length > 0 ? referencesCard(organizationId, references) : null,
    card(
      tr("識別情報", "Identity"),
      h(
        "div",
        { class: "card__body rows" },
        field("UID", copyable(found.uid)),
        field(tr("スペース", "Space"), found.space),
        field("Form", copyable(found.form)),
        field(tr("世代", "Generation"), String(found.generation)),
        field(tr("観測世代", "Observed generation"), String(found.observedGeneration)),
        field(tr("段階", "Phase"), found.phase),
        field(
          tr("最終操作", "Last operation"),
          found.lastOperation
            ? h(
                "a",
                { ...linkProps(`/resources?operation=${encodeURIComponent(found.lastOperation)}`) },
                found.lastOperation,
              )
            : "—",
        ),
      ),
    ),
    card(tr("宣言した設定", "Declared spec"), jsonBlock(found.spec)),
    card(
      tr("観測状態", "Observed state"),
      found.observedAt
        ? jsonBlock(found.observed)
        : empty(
            tr("まだ観測されていません", "Nothing observed"),
            tr(
              "Hostはまだこの世代を観測していません。",
              "The Host has not observed this generation yet.",
            ),
          ),
    ),
    card(tr("出力", "Output"), jsonBlock(found.output)),
  );
}

/** The Resources this spec names, by name, so the graph can be walked rather than read. */
function referencesCard(organizationId: string, references: readonly SpecReference[]): Child {
  const named = resource(async () => {
    const uids = [...new Set(references.map((reference) => reference.uid))];
    const answers = await Promise.all(
      uids.map((uid) =>
        api.resource(organizationId, uid).then(
          (target) => [uid, target] as const,
          () => [uid, null] as const,
        ),
      ),
    );
    return new Map<string, ResourceSummary | null>(answers);
  });
  return card(
    tr("参照しているリソース", "Resources it names"),
    h(
      "div",
      { class: "card__body rows" },
      ...references.map((reference) =>
        field(
          reference.path,
          live(() => {
            const state = named.get();
            const target = state.state === "ready" ? state.value.get(reference.uid) : undefined;
            if (target === undefined) return h("span", { class: "mono dim" }, reference.uid);
            if (target === null)
              return h(
                "span",
                { class: "dim" },
                h("span", { class: "mono" }, reference.uid),
                text(tr("（この組織にはありません）", " — not in this organization")),
              );
            return h(
              "span",
              { class: "ref" },
              h("a", { class: "mono", ...linkProps(resourcePath(target.uid)) }, target.name),
              h("span", { class: "dim" }, formLabel(target.form)),
            );
          }),
        ),
      ),
    ),
  );
}

function field(label: string, value: Child): Child {
  return h(
    "div",
    { class: "row" },
    h("div", { class: "row__label" }, label),
    h("div", { class: "row__value" }, value),
  );
}
