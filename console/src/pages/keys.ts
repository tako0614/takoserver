import type { ApiKey } from "../api.ts";
import { type Child, h, live, text } from "../dom.ts";
import { tr } from "../i18n.ts";
import { DEFAULT_KEY_SCOPES, keyScopeGroups, keyUsage } from "../key-scopes.ts";
import { effect, resource, signal } from "../reactive.ts";
import { route } from "../router.ts";
import {
  api,
  captureSelectedOrganizationScope,
  captureSessionScope,
  hostV2Base,
} from "../state.ts";
import {
  badge,
  card,
  copyable,
  empty,
  explain,
  ICON,
  icon,
  type ModalOptions,
  openModal,
  toast,
  when,
  whenReady,
} from "../ui.ts";

const LIFETIMES: readonly { readonly label: () => string; readonly seconds: number }[] = [
  { label: () => tr("30日", "30 days"), seconds: 30 * 86_400 },
  { label: () => tr("90日", "90 days"), seconds: 90 * 86_400 },
  { label: () => tr("1年", "1 year"), seconds: 365 * 86_400 },
];

interface UnshownKey {
  readonly organizationId: string;
  readonly id: string;
  readonly name: string;
  readonly isSessionCurrent: () => boolean;
}

// Same-tab recovery metadata only: never retain the secret or response object.
// Reloading the tab drops these notices; the Host's key list remains authoritative.
const unshownKeys = signal<readonly UnshownKey[]>([]);
effect(() => {
  const previous = unshownKeys();
  const current = previous.filter((key) => key.isSessionCurrent());
  if (current.length !== previous.length) unshownKeys.set(current);
});

function rememberUnshownKey(
  key: ApiKey,
  organizationId: string,
  name: string,
  isSessionCurrent: () => boolean,
): void {
  if (
    !isSessionCurrent() ||
    typeof key !== "object" ||
    key === null ||
    key.organizationId !== organizationId ||
    typeof key.id !== "string" ||
    key.id === "" ||
    key.name !== name
  )
    return;
  const metadata: UnshownKey = { organizationId, id: key.id, name, isSessionCurrent };
  unshownKeys.update((previous) => [
    ...previous.filter(
      (item) =>
        item.isSessionCurrent() && !(item.organizationId === organizationId && item.id === key.id),
    ),
    metadata,
  ]);
}

/**
 * API keys, and the one moment their secret exists.
 *
 * Only a digest is stored, so a secret can be shown exactly once and never
 * again. The dialog that reveals it says so plainly and refuses to be dismissed
 * by a stray click, because "I'll copy it in a second" is how people lose keys.
 */
export function keysPage(organizationId: string): Child {
  const isPageCurrent = captureSelectedOrganizationScope(organizationId);
  const keys = resource(() => api.apiKeys(organizationId));
  // Asked once per page. An already-open dialog follows the answer without
  // replacing the person's inputs; an unreadable document never offers AI.
  const discovery = resource(() => api.hostDiscovery());
  const aiAvailable = (): boolean => {
    const state = discovery.get();
    return state.state === "ready" && state.value.ai;
  };
  const v2Endpoint = (): string => {
    const state = discovery.get();
    return hostV2Base(state.state === "ready" ? state.value : null);
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
          class: "btn",
          type: "button",
          onClick: () => {
            if (isPageCurrent()) keys.reload();
          },
        },
        icon(ICON.refresh, 14),
        text(tr("キー一覧を更新", "Refresh keys")),
      ),
      h(
        "button",
        {
          class: "btn btn--primary",
          type: "button",
          onClick: () => createKey(organizationId, keys.reload, aiAvailable, v2Endpoint()),
        },
        icon(ICON.plus, 14),
        text(tr("キーを作成", "Create key")),
      ),
    ),
    live(() => {
      const listed = keys.get();
      if (!isPageCurrent() || listed.state !== "ready") return null;
      // A local session marker is not remote authorization. Only show metadata
      // already returned by this page's current owner-authorized key list.
      return unshownKeys()
        .filter(
          (key) =>
            key.isSessionCurrent() &&
            key.organizationId === organizationId &&
            listed.value.apiKeys.some(
              (item) =>
                item.organizationId === organizationId &&
                item.id === key.id &&
                item.name === key.name,
            ),
        )
        .map((key) =>
          h(
            "div",
            {
              class: "notice notice--warn",
              role: "status",
              "aria-label": tr("シークレット未表示のAPIキー", "Unshown API key secret"),
            },
            icon(ICON.alert, 15),
            h(
              "div",
              null,
              h("strong", null, key.name),
              h("div", { class: "mono" }, key.id),
              h(
                "p",
                null,
                tr(
                  "作成は成功しましたが、シークレットの表示前にダイアログが閉じられました。再表示はできません。一覧でこのキーを失効し、必要なら新しいキーを作成してください。",
                  "Creation succeeded, but the dialog closed before the secret was shown. It cannot be recovered. Revoke this key in the list, then create another if needed.",
                ),
              ),
              h(
                "button",
                {
                  class: "btn btn--sm",
                  type: "button",
                  onClick: () => {
                    if (isPageCurrent() && key.isSessionCurrent())
                      unshownKeys.update((items) => items.filter((item) => item !== key));
                  },
                },
                tr("通知を閉じる", "Dismiss notice"),
              ),
            ),
          ),
        );
    }),
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
                    "curlや独自のコードから、Host API v2でこの組織のリソースを操作するためのキーを作成できます。",
                    "Create one to manage this organization's Resources over Host API v2 with curl or your own code.",
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
              ...key.scopes.map((scope) => badge(scope)),
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
  const isScopeCurrent = captureSelectedOrganizationScope(organizationId);
  const options: ModalOptions = {
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
      if (!modal.isCurrent()) return;
      try {
        await api.revokeApiKey(organizationId, key.id);
        if (!modal.isCurrent()) return;
        toast(tr("キーを失効しました", "Key revoked"), "ok");
        reload();
        modal.close();
      } catch (error) {
        if (modal.isCurrent()) toast(explain(error as Error), "bad");
      }
    },
  };
  const modal = openScopedKeyModal(options, isScopeCurrent);
}

function createKey(
  organizationId: string,
  reload: () => void,
  aiAvailable: () => boolean,
  v2Endpoint: string,
): void {
  const isScopeCurrent = captureSelectedOrganizationScope(organizationId);
  const isSessionCurrent = captureSessionScope();
  const name = h("input", {
    class: "input",
    id: "create-key-name",
    placeholder: "deploy pipeline",
    autocomplete: "off",
  });
  const chosen = new Set<string>(DEFAULT_KEY_SCOPES);
  const aiFields: HTMLFieldSetElement[] = [];
  const aiBoxes: HTMLInputElement[] = [];
  const lifetime = h(
    "select",
    { class: "select", id: "create-key-lifetime" },
    ...LIFETIMES.map((option, index) =>
      h(
        "option",
        { value: String(option.seconds), ...(index === 1 ? { selected: true } : {}) },
        option.label(),
      ),
    ),
  );

  const options: ModalOptions = {
    title: tr("APIキーを作成", "Create API key"),
    confirmLabel: tr("キーを作成", "Create key"),
    body: h(
      "div",
      { style: { display: "grid", gap: "16px" } },
      h(
        "div",
        { class: "field" },
        h("label", { for: "create-key-name" }, tr("名前", "Name")),
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
        h("span", { class: "field__label" }, tr("スコープ", "Scopes")),
        ...keyScopeGroups(true).map((group) => {
          const field = h(
            "fieldset",
            { class: "checks" },
            h("legend", null, group.label()),
            ...group.scopes.map((scope) => {
              const box = h("input", {
                type: "checkbox",
                ...(chosen.has(scope.id) ? { checked: true } : {}),
                onChange: (event: Event) => {
                  if ((event.target as HTMLInputElement).checked) chosen.add(scope.id);
                  else chosen.delete(scope.id);
                },
              });
              if (scope.id === "ai:invoke") aiBoxes.push(box);
              return h(
                "label",
                { class: "check" },
                box,
                h(
                  "span",
                  { class: "check__text" },
                  h("span", { class: "mono check__id" }, scope.id),
                  h("small", null, scope.blurb()),
                ),
              );
            }),
          );
          if (group.scopes.some((scope) => scope.id === "ai:invoke")) aiFields.push(field);
          return field;
        }),
        h(
          "small",
          null,
          tr(
            "必要なスコープだけを付与してください。後から権限を拡張することはできません。",
            "Grant only what the caller needs. Scopes cannot be widened later.",
          ),
        ),
      ),
      h(
        "div",
        { class: "field" },
        h("label", { for: "create-key-lifetime" }, tr("有効期間", "Expires in")),
        lifetime,
      ),
    ),
    onConfirm: async () => {
      if (!modal.isCurrent()) return;
      if (name.value.trim() === "") {
        toast(tr("キー名を入力してください", "Give the key a name"), "bad");
        return;
      }
      if (chosen.size === 0) {
        toast(tr("スコープを1つ以上選択してください", "Choose at least one scope"), "bad");
        return;
      }
      const requestedName = name.value.trim();
      try {
        const created = await api.createApiKey(organizationId, {
          name: requestedName,
          scopes: [...chosen],
          expiresInSeconds: Number(lifetime.value),
        });
        if (!modal.isCurrent()) {
          rememberUnshownKey(created.apiKey, organizationId, requestedName, isSessionCurrent);
          return;
        }
        modal.close();
        reload();
        revealSecret(organizationId, created.apiKey, created.secret, v2Endpoint, isScopeCurrent);
      } catch (error) {
        if (modal.isCurrent()) toast(explain(error as Error), "bad");
      }
    },
  };
  const stopDiscovery = effect(() => {
    const available = aiAvailable();
    for (const field of aiFields) {
      field.hidden = !available;
      field.disabled = !available;
      field.style.display = available ? "" : "none";
    }
    if (!available) {
      chosen.delete("ai:invoke");
      for (const box of aiBoxes) box.checked = false;
    }
  });
  const modal = openScopedKeyModal({ ...options, onClose: stopDiscovery }, isScopeCurrent);
}

function openScopedKeyModal(options: ModalOptions, isScopeCurrent: () => boolean) {
  const openedRoute = route();
  const isCurrent = (): boolean => route() === openedRoute && isScopeCurrent();
  let open = true;
  let stop = (): void => {};
  const lifetime: KeyModalLifetime = { close: null };
  const close = openModal({
    ...options,
    onClose: () => {
      open = false;
      lifetime.close = null;
      stop();
      options.onClose?.();
    },
  });
  lifetime.close = close;
  stop = watchKeyModalScope(isCurrent, lifetime);
  // An already-retired page may open a dialog before the first effect runs.
  if (!open) stop();
  return { close, isCurrent: () => open && isCurrent() };
}

interface KeyModalLifetime {
  close: (() => void) | null;
}

// Keep the watcher outside the modal's lexical scope. Closing clears its modal
// reference and disposes the signal subscriptions.
function watchKeyModalScope(isScopeCurrent: () => boolean, lifetime: KeyModalLifetime): () => void {
  return effect(() => {
    if (!isScopeCurrent()) lifetime.close?.();
  });
}

const INSTALL_GUIDE_STEPS =
  "https://github.com/tako0614/takoserver/blob/main/docs/self-host-operations.md#8-create-and-serve-a-worker";

function revealSecret(
  organizationId: string,
  key: ApiKey,
  secret: string,
  v2Endpoint: string,
  isScopeCurrent: () => boolean,
): void {
  const usage = keyUsage(v2Endpoint, organizationId, key.scopes);
  const options: ModalOptions = {
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
          // A zero basis lets the secret wrap before the copy button gives up any width.
          h(
            "span",
            { class: "mono", style: { wordBreak: "break-all", flex: "1", minWidth: "0" } },
            secret,
          ),
          copyable(secret, tr("キーをコピー", "copy key")),
        ),
      ),
      usage === null
        ? null
        : h(
            "div",
            { class: "field" },
            h(
              "div",
              {
                style: {
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: "10px",
                },
              },
              h("span", { class: "field__label" }, tr("使い方", "Use it")),
              copyable(usage, tr("コマンドをコピー", "copy commands")),
            ),
            // One command per line, as the shell reads it: scroll rather than wrap.
            h(
              "pre",
              { class: "json", style: { whiteSpace: "pre", overflowWrap: "normal" } },
              usage,
            ),
            h(
              "small",
              null,
              tr(
                "実行すると「API key:」と表示されるので、キーを貼り付けてEnterを押します。キーは画面に表示されず、シェルの履歴にも残りません。このコマンドは組織のリソースを一覧表示します。",
                "Run it, paste the key at the API key: prompt and press Enter. The key is not shown and stays out of shell history. The command lists the organization's Resources.",
              ),
            ),
            h(
              "small",
              null,
              tr("作成と削除は", ""),
              h(
                "a",
                { href: INSTALL_GUIDE_STEPS, target: "_blank", rel: "noopener noreferrer" },
                tr("導入手順書（英語）の手順8〜13", "Steps 8 to 13 of the install guide"),
              ),
              tr(
                "にあります。手順5の変数Fと、手順6で用意した成果物も使います。",
                " create and delete them, using F from step 5 and the artifacts seeded in step 6.",
              ),
            ),
          ),
    ),
  };
  openScopedKeyModal(options, isScopeCurrent);
}
