import type { ResourceSummary } from "../api.ts";
import { type Child, h, live, text } from "../dom.ts";
import { tr } from "../i18n.ts";
import { resource, signal } from "../reactive.ts";
import { health } from "../resource-state.ts";
import { linkProps, navigate, resourcePath } from "../router.ts";
import { api } from "../state.ts";
import { ago, badge, card, empty, ICON, icon, shortDigest, whenReady } from "../ui.ts";
import { createResource } from "./create-resource.ts";

/**
 * Everything the organization has declared.
 *
 * The columns answer the questions a person actually arrives with: is it
 * working, what is it, where does it live, and when did it last move. The Form
 * that produced it is one column over, because in an exact-pin protocol two
 * resources of the same kind are not necessarily the same thing.
 */
export function resourcesPage(organizationId: string): Child {
  const filter = signal("");
  const spaceFilter = signal("");
  const page = resource(() => api.resources(organizationId));
  // Loaded alongside, because the button that creates a resource must offer
  // exactly what this organization may provision — not a list written here.
  const catalog = resource(() => api.catalog(organizationId));

  return h(
    "div",
    { class: "page" },
    h(
      "div",
      { class: "head" },
      h(
        "div",
        { class: "head__text" },
        h("h1", null, tr("リソース", "Resources")),
        h(
          "p",
          null,
          tr(
            "この組織がTakoformで宣言したリソースと、ホストが最後に確認した状態です。",
            "Every resource this organization has declared through Takoform, with the state the Host last observed.",
          ),
        ),
      ),
      h(
        "div",
        { class: "toolbar" },
        h(
          "button",
          { class: "btn", type: "button", onClick: page.reload },
          icon(ICON.refresh, 14),
          text(tr("再読み込み", "Reload")),
        ),
        live(() => {
          const state = catalog.get();
          return h(
            "button",
            {
              class: "btn btn--primary",
              type: "button",
              ...(state.state === "ready" ? {} : { disabled: true }),
              onClick: () => {
                if (state.state === "ready") {
                  createResource(organizationId, state.value.offerings);
                }
              },
            },
            icon(ICON.plus, 14),
            text(tr("リソースを作成", "New resource")),
          );
        }),
      ),
    ),
    live(() =>
      whenReady(
        page.get(),
        ({ resources, cursor }) => {
          if (resources.length === 0) {
            return card(
              null,
              empty(
                tr("リソースがありません", "Nothing declared yet"),
                tr(
                  "ここで作成するか、Takoform providerまたはCLIから適用してください。ホストが受け付けるとすぐに表示されます。",
                  "Declare one here, or apply it with the Takoform provider or the CLI — either way it appears the moment the Host accepts it.",
                ),
              ),
            );
          }
          const spaces = [...new Set(resources.map((entry) => entry.metadata.space))].sort();
          return h(
            "div",
            { style: { display: "grid", gap: "14px" } },
            toolbar(filter, spaceFilter, spaces),
            card(
              null,
              h(
                "div",
                { class: "table-scroll" },
                table(visible(resources, filter(), spaceFilter())),
              ),
            ),
            cursor
              ? h(
                  "div",
                  { class: "dim", style: { fontSize: "12.5px" } },
                  tr(
                    `先頭の${resources.length}件を表示しています。続きがあります。`,
                    `Showing the first ${resources.length}. More pages exist.`,
                  ),
                )
              : null,
          );
        },
        { retry: page.reload },
      ),
    ),
  );
}

function toolbar(
  filter: ReturnType<typeof signal<string>>,
  spaceFilter: ReturnType<typeof signal<string>>,
  spaces: readonly string[],
): Child {
  return h(
    "div",
    { class: "toolbar" },
    h("input", {
      class: "input",
      style: { maxWidth: "300px" },
      type: "search",
      placeholder: tr("名前または種類で絞り込み", "Filter by name or kind"),
      value: filter(),
      onInput: (event: Event) => filter.set((event.target as HTMLInputElement).value),
    }),
    spaces.length > 1
      ? h(
          "select",
          {
            class: "select",
            style: { maxWidth: "200px" },
            onChange: (event: Event) => spaceFilter.set((event.target as HTMLSelectElement).value),
          },
          h("option", { value: "" }, tr("すべてのスペース", "All spaces")),
          ...spaces.map((space) =>
            h(
              "option",
              { value: space, ...(space === spaceFilter() ? { selected: true } : {}) },
              space,
            ),
          ),
        )
      : null,
  );
}

function visible(
  resources: readonly ResourceSummary[],
  needle: string,
  space: string,
): readonly ResourceSummary[] {
  const term = needle.trim().toLowerCase();
  return resources.filter((entry) => {
    if (space !== "" && entry.metadata.space !== space) return false;
    if (term === "") return true;
    return (
      entry.metadata.name.toLowerCase().includes(term) || entry.kind.toLowerCase().includes(term)
    );
  });
}

function table(resources: readonly ResourceSummary[]): Child {
  if (resources.length === 0) {
    return empty(
      tr("一致するリソースがありません", "No match"),
      tr("この条件に一致するリソースはありません。", "Nothing here matches that filter."),
    );
  }
  return h(
    "table",
    null,
    h(
      "thead",
      null,
      h(
        "tr",
        null,
        h("th", null, tr("状態", "State")),
        h("th", null, tr("名前", "Name")),
        h("th", null, tr("種類", "Kind")),
        h("th", null, tr("スペース", "Space")),
        h("th", null, "Form"),
        h("th", null, tr("更新", "Changed")),
      ),
    ),
    h("tbody", null, ...resources.map((entry) => row(entry))),
  );
}

function row(entry: ResourceSummary): Child {
  const state = health(entry);
  const href = resourcePath(entry.metadata.space, entry.kind, entry.metadata.name);
  return h(
    "tr",
    {
      class: "is-clickable",
      // The row is a shortcut; the name is the link. A click that lands on a
      // control inside the row belongs to that control, not to the row.
      onClick: (event: MouseEvent) => {
        const target = event.target as HTMLElement;
        if (target.closest("button, a")) return;
        navigate(href);
      },
    },
    h(
      "td",
      null,
      badge(phaseLabel(state.phase), state.tone, true),
      state.stale
        ? h("span", { style: { marginLeft: "6px" } }, badge(tr("変更あり", "changed"), "accent"))
        : null,
    ),
    h("td", null, h("a", { class: "mono", ...linkProps(href) }, entry.metadata.name)),
    h("td", null, entry.kind),
    h("td", { class: "dim" }, entry.metadata.space),
    h(
      "td",
      { class: "dim mono", style: { fontSize: "12px" } },
      entry.form
        ? `${entry.form.formRef.definitionVersion} · ${shortDigest(entry.form.formRef.schemaDigest)}`
        : "—",
    ),
    h("td", { class: "dim", title: entry.metadata.updatedAt }, ago(entry.metadata.updatedAt)),
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
