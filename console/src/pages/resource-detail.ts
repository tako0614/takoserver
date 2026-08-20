import type { FormRef, ResourceSummary } from "../api.ts";
import { type Child, h, live, text } from "../dom.ts";
import { tr } from "../i18n.ts";
import { resource, signal } from "../reactive.ts";
import { health } from "../resource-state.ts";
import { linkProps, navigate } from "../router.ts";
import { api } from "../state.ts";
import {
  badge,
  card,
  copyable,
  empty,
  ICON,
  icon,
  jsonBlock,
  shortDigest,
  when,
  whenReady,
} from "../ui.ts";
import { deleteResource } from "./create-resource.ts";

/**
 * One resource, in full.
 *
 * The page is arranged around a distinction the protocol makes and most
 * consoles blur: `spec` is what the customer declared, `status.observed` is
 * what the backend actually reports, and they are shown side by side rather
 * than merged into a single "configuration". When they disagree, that
 * disagreement is the most useful thing on the screen.
 */
export function resourceDetailPage(
  organizationId: string,
  address: { space: string; kind: string; name: string },
): Child {
  const tab = signal<"overview" | "spec" | "observed" | "identity">("overview");
  const page = resource(async () => {
    const { resources } = await api.resources(organizationId, { space: address.space });
    return (
      resources.find(
        (entry) => entry.kind === address.kind && entry.metadata.name === address.name,
      ) ?? null
    );
  });

  return h(
    "div",
    { class: "page" },
    live(() =>
      whenReady(
        page.get(),
        (found) =>
          found === null
            ? card(
                null,
                empty(
                  tr("リソースがありません", "No such resource"),
                  tr(
                    `${address.space}スペースに${address.kind} / ${address.name}は存在しません。`,
                    `Nothing named ${address.name} of kind ${address.kind} exists in space ${address.space}.`,
                  ),
                  h(
                    "a",
                    { class: "btn", ...linkProps("/resources") },
                    tr("リソース一覧へ戻る", "Back to resources"),
                  ),
                ),
              )
            : body(found, tab, page.reload, organizationId),
        { retry: page.reload },
      ),
    ),
  );
}

function body(
  found: ResourceSummary,
  tab: ReturnType<typeof signal<"overview" | "spec" | "observed" | "identity">>,
  reload: () => void,
  organizationId: string,
): Child {
  const state = health(found);
  return h(
    "div",
    { style: { display: "grid", gap: "18px" } },
    header(found, reload, organizationId),
    h(
      "div",
      { class: "tabs" },
      ...(
        [
          ["overview", tr("概要", "Overview")],
          ["spec", tr("宣言", "Declared")],
          ["observed", tr("観測状態", "Observed")],
          ["identity", tr("Formと識別情報", "Form & identity")],
        ] as const
      ).map(([key, label]) =>
        h(
          "button",
          {
            class: "tab",
            type: "button",
            role: "tab",
            "aria-selected": tab() === key ? "true" : "false",
            onClick: () => tab.set(key),
          },
          label,
        ),
      ),
    ),
    tab() === "overview"
      ? overview(found, state)
      : tab() === "spec"
        ? card(
            tr("宣言した設定", "Declared spec"),
            found.spec
              ? jsonBlock(found.spec)
              : empty(
                  tr("設定がありません", "No spec recorded"),
                  tr(
                    "このリソースには設定が記録されていません。",
                    "This resource was stored without a spec.",
                  ),
                ),
          )
        : tab() === "observed"
          ? observed(found)
          : identity(found),
  );
}

function header(found: ResourceSummary, reload: () => void, organizationId: string): Child {
  const state = health(found);
  return h(
    "div",
    { class: "head" },
    h(
      "div",
      { class: "head__text" },
      h(
        "div",
        { class: "dim", style: { fontSize: "12.5px", marginBottom: "4px" } },
        h("a", { ...linkProps("/resources") }, tr("リソース", "Resources")),
        text(" / "),
        text(found.metadata.space),
      ),
      h(
        "h1",
        { style: { display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" } },
        h("span", { class: "mono" }, found.metadata.name),
        badge(phaseLabel(state.phase), state.tone, true),
        state.stale ? badge(tr("宣言が未適用", "declaration not yet applied"), "accent") : null,
      ),
      h("p", null, `${found.kind} · ${found.apiVersion}`),
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
      found.form
        ? h(
            "button",
            {
              class: "btn btn--danger",
              type: "button",
              onClick: () =>
                deleteResource(
                  organizationId,
                  {
                    form: (found.form as { formRef: FormRef }).formRef,
                    space: found.metadata.space,
                    name: found.metadata.name,
                    generation: found.metadata.generation,
                  },
                  () => navigate("/resources"),
                ),
            },
            tr("削除", "Delete"),
          )
        : null,
    ),
  );
}

function overview(found: ResourceSummary, state: ReturnType<typeof health>): Child {
  const outputs = found.status?.outputs ?? {};
  const conditions = found.status?.conditions ?? [];
  return h(
    "div",
    { style: { display: "grid", gap: "14px" } },
    state.message
      ? h(
          "div",
          { class: state.tone === "bad" ? "notice notice--bad" : "notice notice--warn" },
          icon(ICON.alert),
          h(
            "div",
            null,
            h("strong", null, state.reason ?? state.phase),
            h("div", { style: { marginTop: "2px" } }, state.message),
          ),
        )
      : null,
    card(
      tr("出力", "Outputs"),
      Object.keys(outputs).length === 0
        ? empty(
            tr("出力がありません", "No outputs"),
            tr(
              "このリソースはほかの宣言から利用できる値を公開していません。",
              "This resource publishes nothing for other declarations to consume.",
            ),
          )
        : h(
            "div",
            { class: "card__body" },
            h(
              "div",
              { class: "rows" },
              ...Object.entries(outputs).map(([key, value]) =>
                h(
                  "div",
                  { class: "row" },
                  h("div", { class: "row__label mono" }, key),
                  h(
                    "div",
                    { class: "row__value" },
                    typeof value === "string" ? copyable(value) : jsonBlock(value),
                  ),
                ),
              ),
            ),
          ),
    ),
    card(
      tr("状態条件", "Conditions"),
      conditions.length === 0
        ? empty(
            tr("状態条件がありません", "No conditions"),
            tr(
              "ホストはこのリソースの状態をまだ報告していません。",
              "The Host has not reported on this resource yet.",
            ),
          )
        : h(
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
                  h("th", null, tr("種類", "Type")),
                  h("th", null, tr("状態", "Status")),
                  h("th", null, tr("理由", "Reason")),
                  h("th", null, tr("メッセージ", "Message")),
                ),
              ),
              h(
                "tbody",
                null,
                ...conditions.map((condition) =>
                  h(
                    "tr",
                    null,
                    h("td", { class: "mono" }, condition.type),
                    h(
                      "td",
                      null,
                      badge(
                        condition.status,
                        condition.status === "True"
                          ? "ok"
                          : condition.status === "False"
                            ? "bad"
                            : "warn",
                      ),
                    ),
                    h("td", { class: "dim" }, condition.reason ?? "—"),
                    h("td", { class: "dim" }, condition.message ?? "—"),
                  ),
                ),
              ),
            ),
          ),
    ),
  );
}

function observed(found: ResourceSummary): Child {
  const value = found.status?.observed;
  return card(
    tr("観測状態", "Observed state"),
    value
      ? jsonBlock(value)
      : empty(
          tr("まだ観測されていません", "Nothing observed"),
          tr(
            "ホストは実行基盤からこのリソースをまだ読み取っていません。作成中は正常な状態です。",
            "The Host has not read this resource back from the provider. That is normal while it is still being made.",
          ),
        ),
  );
}

/**
 * The exact-pin quad, spelled out.
 *
 * This is the part of Takoform that surprises people: identity includes the
 * digest of the schema the resource was created under, so an apparently
 * identical resource made yesterday may be a different Form. Showing the whole
 * quad — and letting it be copied — is what makes that legible instead of
 * mysterious.
 */
function identity(found: ResourceSummary): Child {
  const rows: readonly (readonly [string, Child])[] = [
    [tr("種類", "Kind"), h("span", { class: "mono" }, found.kind)],
    [tr("APIバージョン", "API version"), copyable(found.apiVersion)],
    ...(found.form
      ? ([
          [
            tr("定義バージョン", "Definition version"),
            h(
              "span",
              null,
              h("span", { class: "mono" }, found.form.formRef.definitionVersion),
              h(
                "span",
                { class: "dim", style: { marginLeft: "8px" } },
                tr(
                  "このリソースの作成に使用した定義",
                  "the definition this resource was made under",
                ),
              ),
            ),
          ],
          [
            tr("スキーマダイジェスト", "Schema digest"),
            h(
              "span",
              null,
              copyable(
                found.form.formRef.schemaDigest,
                shortDigest(found.form.formRef.schemaDigest),
              ),
              h(
                "div",
                { class: "dim", style: { marginTop: "2px" } },
                tr(
                  "Form識別情報の一部です。異なるスキーマは異なるFormです。",
                  "part of the Form's identity: a different schema is a different Form",
                ),
              ),
            ),
          ],
        ] as const)
      : []),
    [tr("スペース", "Space"), h("span", { class: "mono" }, found.metadata.space)],
    [tr("名前", "Name"), copyable(found.metadata.name)],
    ["UID", copyable(found.metadata.uid, shortDigest(found.metadata.uid))],
    [
      tr("世代", "Generation"),
      h(
        "span",
        null,
        h("span", { class: "mono" }, found.metadata.generation),
        h(
          "span",
          { class: "dim", style: { marginLeft: "8px" } },
          tr("宣言が変わると増加します", "increments when the declaration changes"),
        ),
      ),
    ],
    [
      tr("リビジョン", "Revision"),
      h(
        "span",
        null,
        h("span", { class: "mono" }, found.metadata.revision),
        h(
          "span",
          { class: "dim", style: { marginLeft: "8px" } },
          tr("更新時に提示する競合防止値", "the fence a write must present"),
        ),
      ),
    ],
    [tr("最終更新", "Last change"), h("span", null, when(found.metadata.updatedAt))],
  ];

  return card(
    tr("識別情報", "Identity"),
    h(
      "div",
      { class: "card__body" },
      h(
        "div",
        { class: "rows" },
        ...rows.map(([label, value]) =>
          h(
            "div",
            { class: "row" },
            h("div", { class: "row__label" }, label),
            h("div", { class: "row__value" }, value),
          ),
        ),
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
