import type { ApiKey } from "../api.ts";
import { type Child, h, live, text } from "../dom.ts";
import { tr } from "../i18n.ts";
import { resource } from "../reactive.ts";
import { api } from "../state.ts";
import {
  badge,
  card,
  copyable,
  empty,
  explain,
  ICON,
  icon,
  openModal,
  toast,
  when,
  whenReady,
} from "../ui.ts";

const SCOPES: readonly { readonly id: string; readonly blurb: () => string }[] = [
  {
    id: "catalog:read",
    blurb: () => tr("販売中の商品と料金を表示します。", "See what is for sale and at what price."),
  },
  {
    id: "resources:read",
    blurb: () => tr("宣言済みリソースを表示します。", "List and inspect declared resources."),
  },
  {
    id: "resources:write",
    blurb: () =>
      tr("Takoformでリソースを作成・削除します。", "Apply and delete resources through Takoform."),
  },
  {
    id: "wallet:read",
    blurb: () => tr("残高と取引履歴を表示します。", "Read the balance and the ledger."),
  },
  { id: "usage:read", blurb: () => tr("使用量明細を表示します。", "Read usage statements.") },
  {
    id: "reseller:write",
    blurb: () =>
      tr(
        "テナントに代わって見積・予約・作成します。",
        "Quote, reserve, and provision on behalf of tenants.",
      ),
  },
];

const LIFETIMES: readonly { readonly label: () => string; readonly seconds: number }[] = [
  { label: () => tr("30日", "30 days"), seconds: 30 * 86_400 },
  { label: () => tr("90日", "90 days"), seconds: 90 * 86_400 },
  { label: () => tr("1年", "1 year"), seconds: 365 * 86_400 },
];

/**
 * API keys, and the one moment their secret exists.
 *
 * Only a digest is stored, so a secret can be shown exactly once and never
 * again. The dialog that reveals it says so plainly and refuses to be dismissed
 * by a stray click, because "I'll copy it in a second" is how people lose keys.
 */
export function keysPage(organizationId: string): Child {
  const keys = resource(() => api.apiKeys(organizationId));

  return h(
    "div",
    { class: "page" },
    h(
      "div",
      { class: "head" },
      h(
        "div",
        { class: "head__text" },
        h("h1", null, tr("APIキー", "API keys")),
        h(
          "p",
          null,
          tr(
            "APIキーは付与されたスコープの範囲でこの組織を操作します。発行元の組織自体を管理することはできません。",
            "Keys act for this organization within the scopes they were given. A key can never administer the organization that issued it.",
          ),
        ),
      ),
      h(
        "button",
        {
          class: "btn btn--primary",
          type: "button",
          onClick: () => createKey(organizationId, keys.reload),
        },
        icon(ICON.plus, 14),
        text(tr("キーを作成", "Create key")),
      ),
    ),
    live(() =>
      whenReady(
        keys.get(),
        ({ apiKeys }) =>
          card(
            null,
            apiKeys.length === 0
              ? empty(
                  tr("APIキーがありません", "No keys"),
                  tr(
                    "Takoform provider、CLI、または独自コードからこの組織を操作するためのキーを作成できます。",
                    "Create one to let the Takoform provider, the CLI, or your own code act for this organization.",
                  ),
                )
              : h("div", { class: "table-scroll" }, table(apiKeys, organizationId, keys.reload)),
          ),
        { retry: keys.reload },
      ),
    ),
  );
}

function table(apiKeys: readonly ApiKey[], organizationId: string, reload: () => void): Child {
  return h(
    "table",
    null,
    h(
      "thead",
      null,
      h(
        "tr",
        null,
        h("th", null, tr("名前", "Name")),
        h("th", null, tr("スコープ", "Scopes")),
        h("th", null, tr("作成日時", "Created")),
        h("th", null, tr("有効期限", "Expires")),
        h("th", null, ""),
      ),
    ),
    h(
      "tbody",
      null,
      ...apiKeys.map((key) => {
        const expired = new Date(key.expiresAt).getTime() < Date.now();
        return h(
          "tr",
          null,
          h(
            "td",
            null,
            h("div", null, key.name),
            h("div", { style: { marginTop: "3px" } }, copyable(key.id)),
          ),
          h(
            "td",
            null,
            h(
              "div",
              { style: { display: "flex", gap: "4px", flexWrap: "wrap" } },
              ...key.scopes.map((scope) => badge(scope, "accent")),
            ),
          ),
          h("td", { class: "dim" }, when(key.createdAt)),
          h(
            "td",
            null,
            expired
              ? badge(tr("期限切れ", "expired"), "bad")
              : h("span", { class: "dim" }, when(key.expiresAt)),
          ),
          h(
            "td",
            { style: { textAlign: "right" } },
            h(
              "button",
              {
                class: "btn btn--sm btn--danger",
                type: "button",
                onClick: () => revoke(organizationId, key, reload),
              },
              tr("失効", "Revoke"),
            ),
          ),
        );
      }),
    ),
  );
}

function revoke(organizationId: string, key: ApiKey, reload: () => void): void {
  const close = openModal({
    title: tr(`${key.name}を失効しますか？`, `Revoke ${key.name}?`),
    confirmLabel: tr("キーを失効", "Revoke key"),
    confirmTone: "danger",
    body: h(
      "div",
      { class: "notice notice--bad" },
      icon(ICON.alert, 15),
      h(
        "div",
        null,
        tr(
          "このキーを利用する処理は直ちに停止します。元に戻せないため、必要な場合は新しいキーを発行してください。",
          "Anything using this key stops working immediately. This cannot be undone; issue a new key instead.",
        ),
      ),
    ),
    onConfirm: async () => {
      try {
        await api.revokeApiKey(organizationId, key.id);
        toast(tr("キーを失効しました", "Key revoked"), "ok");
        reload();
        close();
      } catch (error) {
        toast(explain(error as Error), "bad");
      }
    },
  });
}

function createKey(organizationId: string, reload: () => void): void {
  const name = h("input", { class: "input", placeholder: "deploy pipeline" });
  const chosen = new Set<string>(["catalog:read", "resources:read", "resources:write"]);
  const lifetime = h(
    "select",
    { class: "select" },
    ...LIFETIMES.map((option, index) =>
      h(
        "option",
        { value: String(option.seconds), ...(index === 1 ? { selected: true } : {}) },
        option.label(),
      ),
    ),
  );

  const close = openModal({
    title: tr("APIキーを作成", "Create API key"),
    confirmLabel: tr("キーを作成", "Create key"),
    body: h(
      "div",
      { style: { display: "grid", gap: "16px" } },
      h(
        "div",
        { class: "field" },
        h("label", null, tr("名前", "Name")),
        name,
        h(
          "small",
          null,
          tr(
            "キーの用途を入力します。この名前は一覧だけに表示されます。",
            "What this key is for. It appears in the list and nowhere else.",
          ),
        ),
      ),
      h(
        "div",
        { class: "field" },
        h("label", null, tr("スコープ", "Scopes")),
        h(
          "div",
          { class: "checks" },
          ...SCOPES.map((scope) => {
            const box = h("input", {
              type: "checkbox",
              ...(chosen.has(scope.id) ? { checked: true } : {}),
              onChange: (event: Event) => {
                if ((event.target as HTMLInputElement).checked) chosen.add(scope.id);
                else chosen.delete(scope.id);
              },
            });
            return h(
              "label",
              { class: "check", title: scope.blurb() },
              box,
              h("span", { class: "mono", style: { fontSize: "12px" } }, scope.id),
            );
          }),
        ),
        h(
          "small",
          null,
          tr(
            "必要なスコープだけを付与してください。後から権限を拡張することはできません。",
            "Grant only what the caller needs. Scopes cannot be widened later.",
          ),
        ),
      ),
      h("div", { class: "field" }, h("label", null, tr("有効期間", "Expires in")), lifetime),
    ),
    onConfirm: async () => {
      if (name.value.trim() === "") {
        toast(tr("キー名を入力してください", "Give the key a name"), "bad");
        return;
      }
      if (chosen.size === 0) {
        toast(tr("スコープを1つ以上選択してください", "Choose at least one scope"), "bad");
        return;
      }
      try {
        const created = await api.createApiKey(organizationId, {
          name: name.value.trim(),
          scopes: [...chosen],
          expiresInSeconds: Number(lifetime.value),
        });
        close();
        reload();
        revealSecret(created.apiKey, created.secret);
      } catch (error) {
        toast(explain(error as Error), "bad");
      }
    },
  });
}

function revealSecret(key: ApiKey, secret: string): void {
  openModal({
    title: tr("今すぐキーをコピーしてください", "Copy this key now"),
    dismissLabel: tr("完了", "Done"),
    body: h(
      "div",
      { style: { display: "grid", gap: "14px" } },
      h(
        "div",
        { class: "notice notice--warn" },
        icon(ICON.alert, 15),
        h(
          "div",
          null,
          tr(
            "Takoserverはこのシークレットのダイジェストだけを保存します。再表示できないため、紛失した場合は失効して新しいキーを作成してください。",
            "Takoserver stores only a digest of this secret. It cannot be shown again — if it is lost, revoke the key and create another.",
          ),
        ),
      ),
      h(
        "div",
        { class: "field" },
        h("label", null, key.name),
        h(
          "div",
          {
            class: "json",
            style: {
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: "10px",
            },
          },
          h("span", { class: "mono", style: { wordBreak: "break-all" } }, secret),
          copyable(secret, tr("コピー", "copy")),
        ),
      ),
    ),
  });
}
