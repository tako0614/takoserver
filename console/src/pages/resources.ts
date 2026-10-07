import type { ResourceSummary } from "../api.ts";
import { type Child, h, live, text } from "../dom.ts";
import { tr } from "../i18n.ts";
import { resource, signal } from "../reactive.ts";
import { health } from "../resource-state.ts";
import { linkProps, navigate, resourcePath, route } from "../router.ts";
import { api, currentOrganization } from "../state.ts";
import { ago, badge, card, copyable, empty, explain, ICON, icon, whenReady } from "../ui.ts";
import { createResource } from "./create-resource.ts";

/**
 * Everything the organization has declared.
 *
 * The columns answer the questions a person actually arrives with: is it
 * working, what is it, where does it live, and when did it last move. The
 * exact Form URL is shown rather than a guessed catalog kind.
 */
export function resourcesPage(organizationId: string): Child {
  const filter = signal("");
  const additional = signal<readonly ResourceSummary[]>([]);
  const continuation = signal<{ readonly cursor?: string } | null>(null);
  const loadingMore = signal(false);
  const moreError = signal<Error | null>(null);
  const page = resource(() => api.resources(organizationId));
  let pagingGeneration = 0;
  const reloadResources = (): void => {
    pagingGeneration += 1;
    additional.set([]);
    continuation.set(null);
    loadingMore.set(false);
    moreError.set(null);
    page.reload();
  };
  const operationId = route().query.get("operation");
  // Keep the accepted handle in the URL across refreshes. Checking status is
  // explicit: it never resubmits create/delete or claims acceptance is done.
  const operation = operationId
    ? resource(async () => {
        try {
          return await api.resourceOperation(organizationId, operationId);
        } finally {
          reloadResources();
        }
      })
    : null;
  const reload = (): void => {
    if (operation) operation.reload();
    else reloadResources();
  };
  const loadMore = async (cursor: string): Promise<void> => {
    if (loadingMore() || currentOrganization()?.id !== organizationId) return;
    const mine = ++pagingGeneration;
    loadingMore.set(true);
    moreError.set(null);
    try {
      const next = await api.resources(organizationId, { cursor });
      if (mine !== pagingGeneration || currentOrganization()?.id !== organizationId) return;
      additional.update((loaded) => [...loaded, ...next.resources]);
      continuation.set(next.cursor ? { cursor: next.cursor } : {});
    } catch (error) {
      if (mine === pagingGeneration && currentOrganization()?.id === organizationId) {
        moreError.set(error instanceof Error ? error : new Error(String(error)));
      }
    } finally {
      if (mine === pagingGeneration && currentOrganization()?.id === organizationId) {
        loadingMore.set(false);
      }
    }
  };
  const moreButton = (cursor: string): Child =>
    h(
      "div",
      { class: "toolbar", style: { justifyContent: "center" } },
      h(
        "button",
        {
          class: "btn",
          type: "button",
          ...(loadingMore() ? { disabled: true, "aria-busy": "true" } : {}),
          onClick: () => void loadMore(cursor),
        },
        text(
          loadingMore()
            ? tr("読み込み中…", "Loading…")
            : moreError()
              ? tr("もう一度試す", "Try again")
              : tr("さらに読み込む", "Load more"),
        ),
      ),
    );
  const pagingError = (): Child => {
    const error = moreError();
    return error ? h("div", { class: "notice notice--bad" }, text(explain(error))) : null;
  };
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
          { class: "btn", type: "button", onClick: reload },
          icon(ICON.refresh, 14),
          text(tr("再読み込み", "Reload")),
        ),
        h(
          "button",
          {
            class: "btn btn--primary",
            type: "button",
            onClick: () => createResource(organizationId),
          },
          icon(ICON.plus, 14),
          text(tr("リソースを作成", "New resource")),
        ),
      ),
    ),
    operation && operationId
      ? card(
          tr("受け付けた操作", "Accepted operation"),
          h(
            "div",
            { class: "card__body", style: { display: "grid", gap: "12px" } },
            copyable(operationId),
            live(() =>
              whenReady(
                operation.get(),
                (current) => {
                  if (current.status !== "succeeded" && current.status !== "failed") {
                    return h(
                      "div",
                      { class: "notice" },
                      text(`${current.status} · ${current.effect}`),
                      text(
                        tr(
                          " — まだ完了していません。「再読み込み」で確認してください。",
                          " — not complete. Use Reload to check again.",
                        ),
                      ),
                    );
                  }
                  if (current.status === "failed") {
                    return h(
                      "div",
                      { class: "notice notice--bad" },
                      text(`failed · ${current.effect}`),
                      current.error
                        ? text(` · ${current.error.code}: ${current.error.message}`)
                        : null,
                    );
                  }
                  if (current.action === "delete") {
                    return badge(tr("削除が完了しました", "Deletion complete"), "ok");
                  }
                  return h(
                    "a",
                    { ...linkProps(resourcePath(current.resourceUid)) },
                    tr("リソースを表示", "View resource"),
                  );
                },
                { retry: reload },
              ),
            ),
          ),
        )
      : null,
    live(() =>
      whenReady(
        page.get(),
        ({ resources, cursor }) => {
          if (currentOrganization()?.id !== organizationId) return null;
          const allResources = [...resources, ...additional()];
          const nextCursor = continuation() === null ? cursor : continuation()?.cursor;
          if (allResources.length === 0) {
            return card(
              null,
              h(
                "div",
                { style: { display: "grid", gap: "12px" } },
                empty(
                  tr("リソースがありません", "Nothing declared yet"),
                  tr(
                    "運用者から渡された正確なForm URLでここから作成できます。受理されたリソースも完了前から表示されます。",
                    "Create one here with an exact Form URL supplied by the operator. An accepted resource can appear before execution completes.",
                  ),
                ),
                pagingError(),
                nextCursor ? moreButton(nextCursor) : null,
              ),
            );
          }
          return h(
            "div",
            { style: { display: "grid", gap: "14px" } },
            toolbar(filter),
            nextCursor
              ? h(
                  "div",
                  { class: "dim", style: { fontSize: "12.5px" } },
                  tr(
                    "絞り込み対象は読み込み済みのリソースです。続きも読み込むと検索範囲が広がります。",
                    "Filters match loaded resources only. Load more to search the rest.",
                  ),
                )
              : null,
            card(null, h("div", { class: "table-scroll" }, table(visible(allResources, filter())))),
            pagingError(),
            nextCursor ? moreButton(nextCursor) : null,
          );
        },
        { retry: page.reload },
      ),
    ),
  );
}

function toolbar(filter: ReturnType<typeof signal<string>>): Child {
  return h(
    "div",
    { class: "toolbar" },
    h("input", {
      class: "input",
      style: { maxWidth: "300px" },
      type: "search",
      placeholder: tr("名前またはFormで絞り込み", "Filter by name or Form"),
      value: filter(),
      onInput: (event: Event) => filter.set((event.target as HTMLInputElement).value),
    }),
  );
}

function visible(
  resources: readonly ResourceSummary[],
  needle: string,
): readonly ResourceSummary[] {
  const term = needle.trim().toLowerCase();
  return resources.filter((entry) => {
    if (term === "") return true;
    return entry.name.toLowerCase().includes(term) || entry.form.toLowerCase().includes(term);
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
        h("th", null, tr("スペース", "Space")),
        h("th", null, "Form"),
        h("th", null, tr("観測", "Observed")),
      ),
    ),
    h("tbody", null, ...resources.map((entry) => row(entry))),
  );
}

function row(entry: ResourceSummary): Child {
  const state = health(entry);
  const href = resourcePath(entry.uid);
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
    h("td", null, h("a", { class: "mono", ...linkProps(href) }, entry.name)),
    h("td", { class: "dim" }, entry.space),
    h("td", { class: "dim mono", style: { fontSize: "12px" } }, entry.form),
    h(
      "td",
      { class: "dim", title: entry.observedAt ?? "" },
      entry.observedAt ? ago(entry.observedAt) : "—",
    ),
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
