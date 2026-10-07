import type { ResourceSummary } from "../api.ts";
import { ApiError } from "../api.ts";
import { type Child, h, live, text } from "../dom.ts";
import { tr } from "../i18n.ts";
import { resource } from "../reactive.ts";
import { health } from "../resource-state.ts";
import { linkProps, route } from "../router.ts";
import { api, currentOrganization } from "../state.ts";
import { badge, card, copyable, empty, ICON, icon, jsonBlock, whenReady } from "../ui.ts";
import { deleteResource, updateResource } from "./create-resource.ts";

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
          h("span", { class: "mono" }, found.name),
          text(" "),
          badge(phaseLabel(state.phase), state.tone, true),
        ),
        h("p", { class: "mono" }, found.form),
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

function field(label: string, value: Child): Child {
  return h(
    "div",
    { class: "row" },
    h("div", { class: "row__label" }, label),
    h("div", { class: "row__value" }, value),
  );
}

function phaseLabel(phase: ReturnType<typeof health>["phase"]): string {
  const japanese = {
    Ready: "稼働中",
    Pending: "処理中",
    Failed: "失敗",
    Deleting: "削除中",
    Unknown: "不明",
  } as const;
  return tr(japanese[phase], phase);
}
