import { type ConsoleLocale, tr } from "./i18n.ts";

export interface ScopeOption {
  readonly id: string;
  readonly blurb: () => string;
}

export interface ScopeGroup {
  readonly label: () => string;
  readonly scopes: readonly ScopeOption[];
}

/**
 * What a key may be given, most common first, each saying what it opens.
 * `ai:invoke` is offered only where this Host serves `/v1/ai`.
 */
export function keyScopeGroups(aiAvailable: boolean): readonly ScopeGroup[] {
  return [
    {
      label: () => tr("リソース", "Resources"),
      scopes: [
        {
          id: "resources:write",
          blurb: () =>
            tr(
              "リソースとその接続を作成・変更・削除します。読み取りも含みます。",
              "Create, change and delete Resources and their attachments. Includes reading them.",
            ),
        },
        {
          id: "resources:read",
          blurb: () =>
            tr("リソースとその操作を読み取ります。", "Read Resources and their Operations."),
        },
      ],
    },
    ...(aiAvailable
      ? [
          {
            label: () => "AI",
            scopes: [
              {
                id: "ai:invoke",
                blurb: () =>
                  tr(
                    "/v1/aiでチャット補完を呼び出します。料金のあるモデルはウォレットから支払います。",
                    "Call chat completions at /v1/ai. Priced models are paid from the wallet.",
                  ),
              },
            ],
          },
        ]
      : []),
    {
      label: () => tr("ウォレットと使用量", "Wallet and usage"),
      scopes: [
        {
          id: "wallet:read",
          blurb: () => tr("残高と取引履歴を読み取ります。", "Read the balance and the ledger."),
        },
        {
          id: "usage:read",
          blurb: () => tr("使用量の記録を読み取ります。", "Read usage records."),
        },
      ],
    },
    {
      label: () => tr("再販", "Resale"),
      scopes: [
        {
          id: "catalog:read",
          blurb: () =>
            tr(
              "/v1/catalogの商品と料金を読み取ります。",
              "Read the Offerings and prices at /v1/catalog.",
            ),
        },
        {
          id: "reseller:write",
          blurb: () =>
            tr(
              "テナントに代わって見積・予約・確定・解放し、作成用の使い捨てトークンを発行します。費用はウォレットから支払います。",
              "Quote, reserve, capture and release on behalf of tenants, and issue single-use provision tokens. Paid from the wallet.",
            ),
        },
      ],
    },
  ];
}

/** A writer can read what it writes, so one scope covers the common case. */
export const DEFAULT_KEY_SCOPES: readonly string[] = ["resources:write"];

/** A first request with the new key, the way the install guide makes it. */
export function keyUsage(origin: string, organizationId: string, locale: ConsoleLocale): string {
  const comment =
    locale === "ja"
      ? "キーを貼り付けます。シェルの履歴には残りません"
      : "paste the key; it stays out of shell history";
  return [
    `HOST=${origin}`,
    `read -r KEY   # ${comment}`,
    'curl -sS -G "$HOST/apis/forms.takoform.com/v2/resources" \\',
    `  --data-urlencode space=${organizationId} \\`,
    '  -H "authorization: Bearer $KEY"',
  ].join("\n");
}
