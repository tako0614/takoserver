import type { ResourceOperation, ResourceSummary } from "../api.ts";
import { type Child, h, live, text } from "../dom.ts";
import { firstRunNote, once } from "../first-run.ts";
import { formName } from "../forms.ts";
import { tr } from "../i18n.ts";
import { resource, signal } from "../reactive.ts";
import {
  canReplayResourceIntent,
  sendResourceIntent,
  settleResourceIntent,
  uncertainResourceIntents,
} from "../resource-intent.ts";
import { health, matchingResources, phaseLabel } from "../resource-state.ts";
import { linkProps, navigate, resourcePath, route } from "../router.ts";
import { api, currentOrganization } from "../state.ts";
import { ago, badge, card, copyable, empty, explain, ICON, icon, whenReady } from "../ui.ts";
import { createResource } from "./create-resource.ts";

/** How an operation still in progress is followed: every 1.5 s for up to two minutes. */
export const OPERATION_FOLLOW = { intervalMs: 1_500, budgetMs: 120_000 };
/** Bumped by each build of the Resources page; only the newest build follows. */
let followGeneration = 0;

/** What a failed operation left behind, which decides whether a retry is safe. */
function failedEffect(effect: string): string {
  switch (effect) {
    case "none":
      return tr("変更はありません。", "Nothing was changed.");
    case "partial":
      return tr(
        "一部が反映されています。リソースを確認してください。",
        "Partly applied. Check the Resource.",
      );
    case "complete":
      return tr("変更は反映されています。", "The change was applied.");
    default:
      return tr(
        "反映されたか分かりません。リソースを確認してください。",
        "Unknown whether it was applied. Check the Resource.",
      );
  }
}

function operationSettled(operation: { readonly status: string }): boolean {
  return operation.status === "succeeded" || operation.status === "failed";
}

/**
 * Everything the organization has declared.
 *
 * The columns answer the questions a person actually arrives with: is it
 * working, what is it, where does it live, and when did it last move. A
 * `?form=` in the address narrows the list to that exact Form URL, so the
 * overview can link to one Form's Resources; the text filter still applies.
 */
export function resourcesPage(organizationId: string): Child {
  // Made on the first empty render and reused, so a re-render does not ask the
  // Host again.
  const note = once(() => firstRunNote(organizationId));
  const filter = signal("");
  const onlyForm = route().query.get("form");
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
  const intentId = route().query.get("intent");
  const outstanding = uncertainResourceIntents(organizationId);
  const acceptanceUnknown = route().query.get("acceptance") === "unknown" || outstanding.length > 0;
  const recovering = signal(false);
  const recoveryError = signal<Error | null>(null);
  const retryExact = async (id: string): Promise<void> => {
    if (recovering() || currentOrganization()?.id !== organizationId) return;
    recovering.set(true);
    recoveryError.set(null);
    try {
      const accepted = await sendResourceIntent(id);
      if (currentOrganization()?.id === organizationId)
        navigate(
          `/resources?operation=${encodeURIComponent(accepted.id)}&intent=${encodeURIComponent(id)}`,
        );
    } catch (error) {
      recoveryError.set(error instanceof Error ? error : new Error(String(error)));
    } finally {
      recovering.set(false);
    }
  };
  // Keep the accepted handle in the URL across refreshes. Checking status only
  // reads: it never resubmits create/delete or claims acceptance is done. An
  // operation still in progress is read again on its own for a while, the way
  // the install guide's helper waits, so nobody has to keep pressing Reload.
  const followUntil = Date.now() + OPERATION_FOLLOW.budgetMs;
  const following = signal(true);
  // The last answer stays on screen while the next check is in flight, so the
  // card does not blink back to its loading state every 1.5 s.
  const latest = signal<ResourceOperation | null>(null);
  let followTimer: ReturnType<typeof setTimeout> | undefined;
  // Each build of this page follows on its own token. A rebuild (a language
  // switch, say) takes a new one, so the replaced page stops checking.
  const followToken = ++followGeneration;
  // Stop once this page has gone: rebuilt, another route, another
  // organization, or no document at all (a test that has finished).
  const stillShown = (): boolean =>
    followToken === followGeneration &&
    typeof document !== "undefined" &&
    currentOrganization()?.id === organizationId &&
    route().path === "/resources" &&
    route().query.get("operation") === operationId;
  const operation = operationId
    ? resource(async () => {
        clearTimeout(followTimer);
        try {
          const observed = await api.resourceOperation(organizationId, operationId);
          if (intentId) settleResourceIntent(intentId, observed);
          latest.set(observed);
          if (operationSettled(observed)) {
            following.set(false);
            reloadResources();
          } else if (Date.now() < followUntil) {
            followTimer = setTimeout(() => {
              if (stillShown()) operation?.reload();
            }, OPERATION_FOLLOW.intervalMs);
          } else {
            following.set(false);
          }
          return observed;
        } catch (error) {
          following.set(false);
          reloadResources();
          throw error;
        }
      })
    : null;
  const reload = (): void => {
    if (operation) operation.reload();
    else reloadResources();
  };
  const describeOperation = (current: ResourceOperation): Child => {
    const raw = h("span", { class: "mono dim" }, ` (${current.status})`);
    if (!operationSettled(current)) {
      return h(
        "div",
        { class: "notice" },
        following()
          ? tr("処理中です。自動で確認しています。", "In progress. Checking automatically.")
          : tr(
              "まだ完了していません。「再読み込み」で確認してください。",
              "Not complete yet. Use Reload to check again.",
            ),
        raw,
      );
    }
    if (current.status === "failed") {
      return h(
        "div",
        { class: "notice notice--bad" },
        tr("失敗しました", "Failed"),
        current.error
          ? h(
              "span",
              null,
              text(`${tr("：", ": ")}${current.error.message} `),
              h("span", { class: "mono dim" }, `(${current.error.code})`),
            )
          : raw,
        // Whether anything changed decides whether a retry is safe.
        h("div", null, failedEffect(current.effect)),
      );
    }
    if (current.action === "delete") {
      return badge(tr("削除が完了しました", "Deletion complete"), "ok");
    }
    return h(
      "div",
      { class: "toolbar" },
      badge(tr("完了しました", "Done"), "ok"),
      h(
        "a",
        { ...linkProps(resourcePath(current.resourceUid)) },
        tr("リソースを表示", "View resource"),
      ),
    );
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
            "この組織がTakoformで宣言したリソースと、Hostが最後に確認した状態です。",
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
    acceptanceUnknown
      ? card(
          tr("受理結果が不明です", "Acceptance is unknown"),
          h(
            "div",
            { class: "card__body", style: { display: "grid", gap: "12px" } },
            h(
              "div",
              { class: "notice notice--warn" },
              tr(
                "この一覧と対象リソースを読み直してください。表示がないことだけでは未受理を証明できません。ページ再読み込み後に正確な再送情報がない場合や再送期限後は運用者に確認してください。新しいキーで同じ操作を送らないでください。",
                "Read this inventory and the affected Resource. Absence here does not prove rejection. After a full reload without the exact request, or after the replay deadline, ask the operator to reconcile; do not submit the same intent under a new key.",
              ),
            ),
            ...outstanding.map((intent) =>
              h(
                "div",
                { class: "toolbar" },
                h(
                  "span",
                  { class: "mono" },
                  `${intent.body.action} · ${intent.body.action === "create" ? intent.body.name : intent.body.uid}`,
                ),
                live(() =>
                  h(
                    "button",
                    {
                      class: "btn",
                      type: "button",
                      ...(recovering() || !canReplayResourceIntent(intent)
                        ? { disabled: true }
                        : {}),
                      onClick: () => void retryExact(intent.id),
                    },
                    tr("同じ要求を再送", "Retry exact request"),
                  ),
                ),
                !canReplayResourceIntent(intent)
                  ? tr("再送期限を過ぎました", "Replay window expired")
                  : null,
              ),
            ),
            live(() =>
              recoveryError()
                ? h("div", { class: "notice notice--bad" }, explain(recoveryError() as Error))
                : null,
            ),
          ),
        )
      : null,
    operation && operationId
      ? card(
          tr("受け付けた操作", "Accepted operation"),
          h(
            "div",
            { class: "card__body", style: { display: "grid", gap: "12px" } },
            copyable(operationId),
            live(() => {
              const state = operation.get();
              const shown = latest();
              return state.state === "loading" && shown
                ? describeOperation(shown)
                : whenReady(state, describeOperation, { retry: reload });
            }),
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
                empty(tr("リソースがありません", "Nothing declared yet"), note()),
                pagingError(),
                nextCursor ? moreButton(nextCursor) : null,
              ),
            );
          }
          return h(
            "div",
            { style: { display: "grid", gap: "14px" } },
            toolbar(filter),
            onlyForm ? formNote(onlyForm) : null,
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
            card(
              null,
              h(
                "div",
                { class: "table-scroll" },
                table(
                  matchingResources(
                    onlyForm
                      ? allResources.filter((entry) => entry.form === onlyForm)
                      : allResources,
                    filter(),
                  ),
                ),
              ),
            ),
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
      "aria-label": tr("名前またはFormで絞り込み", "Filter by name or Form"),
      value: filter(),
      onInput: (event: Event) => filter.set((event.target as HTMLInputElement).value),
    }),
  );
}

/** Says which Form the list is narrowed to, with the way back to all of them. */
function formNote(form: string): Child {
  return h(
    "div",
    { class: "filter-note" },
    text(tr("Form：", "Form: ")),
    h("strong", { title: form }, formName(form)),
    text(" · "),
    h("a", { ...linkProps("/resources") }, tr("すべて表示", "Show all")),
  );
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
    // Explicit roles keep the table announced as a table where a browser
    // drops native semantics for the stacked phone layout.
    { class: "resource-table", role: "table" },
    h(
      "thead",
      { role: "rowgroup" },
      h(
        "tr",
        { role: "row" },
        h("th", { role: "columnheader" }, tr("状態", "State")),
        h("th", { role: "columnheader" }, tr("名前", "Name")),
        h("th", { role: "columnheader" }, "Form"),
        h("th", { role: "columnheader" }, tr("観測", "Observed")),
      ),
    ),
    h("tbody", { role: "rowgroup" }, ...resources.map((entry) => row(entry))),
  );
}

function row(entry: ResourceSummary): Child {
  const state = health(entry);
  const href = resourcePath(entry.uid);
  return h(
    "tr",
    {
      class: "is-clickable",
      role: "row",
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
      { class: "resource-state", role: "cell" },
      badge(phaseLabel(state.phase), state.tone, true),
      state.stale
        ? h("span", { style: { marginLeft: "6px" } }, badge(tr("変更あり", "changed"), "accent"))
        : null,
    ),
    // Every row is in the selected organization's Space, so the Space is
    // not repeated per row. A long name is cut with an ellipsis (the whole
    // name is its title and the detail page heading). The Form reads as its
    // kind and version; the exact URL is its title and on the detail page.
    h(
      "td",
      { class: "resource-name", role: "cell" },
      h("a", { class: "mono truncate", title: entry.name, ...linkProps(href) }, entry.name),
    ),
    h("td", { class: "resource-form dim", role: "cell", title: entry.form }, formName(entry.form)),
    h(
      "td",
      {
        class: "resource-observed dim",
        role: "cell",
        title: entry.observedAt ?? "",
        "data-label": tr("観測", "Observed"),
      },
      entry.observedAt ? ago(entry.observedAt) : "—",
    ),
  );
}
