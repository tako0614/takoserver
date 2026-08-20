import type { Organization } from "../api.ts";
import { type Child, h, live, text } from "../dom.ts";
import { tr } from "../i18n.ts";
import { resource } from "../reactive.ts";
import { byKind, health } from "../resource-state.ts";
import { linkProps, resourcePath } from "../router.ts";
import { api } from "../state.ts";
import { ago, badge, card, copyable, empty, ICON, icon, money, stat, whenReady } from "../ui.ts";

/**
 * The first screen, answering the two questions someone signs in with: is
 * anything broken, and can I still pay for it.
 *
 * Everything else on this page is a shortcut. Nothing is summarised in a way
 * that could hide a failure — a kind with something failing says so on the
 * tile rather than only in the list one click away.
 */
export function overviewPage(organization: Organization): Child {
  const wallet = resource(() => api.wallet(organization.id));
  const resources = resource(() => api.resources(organization.id));
  const operations = resource(() => api.operations(organization.id));

  return h(
    "div",
    { class: "page" },
    h(
      "div",
      { class: "head" },
      h(
        "div",
        { class: "head__text" },
        h("h1", null, organization.name),
        h(
          "p",
          null,
          tr(
            "Takoformリソース、前払い残高、最近の変更を確認できます。",
            "Takoform resources, prepaid balance, and what changed recently.",
          ),
        ),
      ),
    ),
    live(() =>
      h(
        "div",
        { class: "grid" },
        whenReady(
          wallet.get(),
          ({ wallet: held }) =>
            h(
              "div",
              { style: { display: "contents" } },
              stat(
                tr("利用可能", "Available"),
                money(held.availableMinor, held.currency),
                held.heldMinor > 0
                  ? tr(
                      `${money(held.heldMinor, held.currency)}を処理中の操作に確保中`,
                      `${money(held.heldMinor, held.currency)} held against live work`,
                    )
                  : tr("確保中の金額はありません", "nothing held"),
              ),
              stat(
                tr("確定残高", "Settled"),
                money(held.settledMinor, held.currency),
                tr("入金と確定済み請求", "credited and captured"),
              ),
            ),
          { skeleton: h("div", { class: "card" }, h("div", { class: "card__body skeleton" })) },
        ),
        whenReady(
          resources.get(),
          ({ resources: all }) => {
            const failing = all.filter((entry) => health(entry).phase === "Failed").length;
            return stat(
              tr("リソース", "Resources"),
              String(all.length),
              failing === 0
                ? tr("すべて正常です", "all reporting healthy")
                : h(
                    "span",
                    { style: { color: "var(--bad)" } },
                    tr(`${failing}件が失敗`, `${failing} failing`),
                  ),
            );
          },
          { skeleton: h("div", { class: "card" }, h("div", { class: "card__body skeleton" })) },
        ),
      ),
    ),
    live(() =>
      whenReady(
        resources.get(),
        ({ resources: all }) =>
          all.length === 0
            ? card(
                tr("リソース", "Resources"),
                empty(
                  tr("リソースがありません", "Nothing declared yet"),
                  tr(
                    "Takoform providerをこの組織へ接続して宣言を適用してください。ホストが受け付けたリソースがここに表示されます。",
                    "Point the Takoform provider at this organization and apply a declaration. Whatever the Host accepts shows up here.",
                  ),
                ),
              )
            : card(
                tr("種類別", "By kind"),
                h(
                  "div",
                  { class: "card__body" },
                  h(
                    "div",
                    { class: "grid" },
                    ...byKind(all).map((entry) =>
                      h(
                        "a",
                        {
                          class: "card",
                          style: { display: "block" },
                          ...linkProps(`/resources?kind=${encodeURIComponent(entry.kind)}`),
                        },
                        h(
                          "div",
                          { class: "card__body" },
                          h("div", { class: "stat__label" }, entry.kind),
                          h("div", { class: "stat__value" }, String(entry.total)),
                          entry.failing > 0
                            ? h(
                                "div",
                                { style: { marginTop: "6px" } },
                                badge(
                                  tr(`${entry.failing}件が失敗`, `${entry.failing} failing`),
                                  "bad",
                                  true,
                                ),
                              )
                            : null,
                        ),
                      ),
                    ),
                  ),
                ),
                h(
                  "a",
                  { class: "btn btn--sm", ...linkProps("/resources") },
                  text(tr("すべて表示", "View all")),
                  icon(ICON.chevron, 13),
                ),
              ),
        { retry: resources.reload },
      ),
    ),
    live(() =>
      whenReady(
        resources.get(),
        ({ resources: all }) => {
          const attention = all.filter((entry) => {
            const state = health(entry);
            return state.phase === "Failed" || state.stale;
          });
          if (attention.length === 0) return h("div", { style: { display: "none" } });
          return card(
            tr("確認が必要", "Needs attention"),
            h(
              "div",
              { class: "table-scroll" },
              h(
                "table",
                null,
                h(
                  "thead",
                  null,
                  h(
                    "tr",
                    null,
                    h("th", null, tr("リソース", "Resource")),
                    h("th", null, tr("状態", "State")),
                    h("th", null, tr("理由", "Why")),
                  ),
                ),
                h(
                  "tbody",
                  null,
                  ...attention.slice(0, 8).map((entry) => {
                    const state = health(entry);
                    return h(
                      "tr",
                      null,
                      h(
                        "td",
                        null,
                        h(
                          "a",
                          {
                            class: "mono",
                            ...linkProps(
                              resourcePath(entry.metadata.space, entry.kind, entry.metadata.name),
                            ),
                          },
                          entry.metadata.name,
                        ),
                      ),
                      h("td", null, badge(phaseLabel(state.phase), state.tone, true)),
                      h(
                        "td",
                        { class: "dim" },
                        state.message ??
                          (state.stale
                            ? tr(
                                "最新の宣言がまだ適用されていません",
                                "the latest declaration has not been applied",
                              )
                            : "—"),
                      ),
                    );
                  }),
                ),
              ),
            ),
          );
        },
        { skeleton: h("div", { style: { display: "none" } }) },
      ),
    ),
    live(() =>
      whenReady(
        operations.get(),
        ({ operations: all }) =>
          all.length === 0
            ? h("div", { style: { display: "none" } })
            : card(
                tr("最近の操作", "Recent operations"),
                h(
                  "div",
                  { class: "table-scroll" },
                  h(
                    "table",
                    null,
                    h(
                      "thead",
                      null,
                      h(
                        "tr",
                        null,
                        h("th", null, tr("操作", "Operation")),
                        h("th", null, tr("結果", "Result")),
                        h("th", null, tr("日時", "When")),
                        h("th", null, "Id"),
                      ),
                    ),
                    h(
                      "tbody",
                      null,
                      ...all
                        .slice(0, 10)
                        .map((entry) =>
                          h(
                            "tr",
                            null,
                            h("td", { class: "mono" }, entry.operation),
                            h(
                              "td",
                              null,
                              badge(entry.state, entry.state === "succeeded" ? "ok" : "bad"),
                            ),
                            h("td", { class: "dim" }, ago(entry.createdAt)),
                            h("td", null, copyable(entry.id)),
                          ),
                        ),
                    ),
                  ),
                ),
              ),
        { skeleton: h("div", { style: { display: "none" } }) },
      ),
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
