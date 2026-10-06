/**
 * The page Takoserver shows a person who arrives without an application.
 *
 * One page, rendered in two places: the API answers it at its own root, and the
 * apex serves it as a file. Writing it twice would produce two descriptions of
 * one product, and they would disagree within a month.
 */

export interface LandingOptions {
  /** Where the console is, if this deployment has one. */
  readonly consoleOrigin: string | null;
  /** Prefix for the API links. Empty when the page is served by the API. */
  readonly apiOrigin: string | null;
  /** Static locale for the page body; the API root defaults to English. */
  readonly locale?: "en" | "ja";
}

const landingMessages = {
  en: {
    description: "A Takoform Host that owns accounts, money, and machines.",
    console: "Open the console",
    eyebrow: "Takoform Host",
    headline: "Run a Takoform Host.",
    lede: "Manage resources against published Form URLs, on infrastructure owned by the Host operator. Check this Host's support before choosing a Form.",
    products: "Host primitives",
    formTitle: "Exact Form identity",
    formBody:
      "An exact, versioned HTTPS URL identifies the resource contract. Support depends on the configured implementation.",
    holdTitle: "Organization ownership",
    holdBody:
      "Replace an API key without losing resource ownership. Each key keeps its own read and write permissions.",
    objectTitle: "Resource lifecycle",
    objectBody:
      "Create, read, update and delete through Host API v2. Track accepted changes by their Operation.",
    meterTitle: "Durable recovery",
    meterBody:
      "Retry with the same operation key. A lost response stays unresolved until the recorded effect can be reconciled.",
    discovery: "The Host describes itself",
    billingTitle: "Usage-based, prepaid billing",
    billingBody:
      "Accounts, wallet and service billing are separate product APIs. Their presence does not mean every Form is available or that v2 resource billing is enabled.",
    onSuccess: "on success",
    onFailure: "on failure",
    selfhostTitle: "Open source. Self-host the whole Host.",
    selfhostBody:
      "Configure the HTTPS origin, v2 documentation URLs and a persistent cursor key before starting. Enable only the Form backends and artifact grants you intend to provide.",
    endpoints: "Endpoints",
    source: "source",
    api: "API description",
    product: "Product discovery",
    host: "Takoform Host discovery",
  },
  ja: {
    description: "アカウント、資金、マシンを管理するTakoform Host。",
    console: "コンソールを開く",
    eyebrow: "Takoform Host",
    headline: "Takoform Hostを、自分の基盤で動かす。",
    lede: "公開されたFormの仕様URLを指定して、Host運営者の基盤上で資源を管理します。使う前に、そのHostの対応範囲を確認できます。",
    products: "Hostの基本機能",
    formTitle: "厳密なForm同一性",
    formBody:
      "版固定のHTTPS URLで資源の契約を識別します。対応範囲は設定された実装によって異なります。",
    holdTitle: "組織単位の所有",
    holdBody:
      "APIキーを交換しても資源の所有は変わりません。各キーの読み取り・書き込み権限は個別に確認します。",
    objectTitle: "資源のライフサイクル",
    objectBody: "Host API v2から作成・取得・更新・削除し、受理された変更はOperationで追跡します。",
    meterTitle: "永続状態からの復旧",
    meterBody:
      "再送は同じ操作キーで行います。応答を失った処理は、記録した実行結果を照合できるまで未確定として保持します。",
    discovery: "Hostのディスカバリー",
    billingTitle: "前払い・使用量ベースの課金",
    billingBody:
      "アカウント・ウォレット・サービス課金は独立した製品APIです。これらが存在しても、全Formへの対応やv2資源への課金が有効という意味ではありません。",
    onSuccess: "成功時",
    onFailure: "失敗時",
    selfhostTitle: "オープンソース。Hostを自分で動かす。",
    selfhostBody:
      "起動前にHTTPS origin、v2の案内URL、永続するcursor鍵を設定します。提供するForm backendと、artifactの取得権限を明示的に選びます。",
    endpoints: "エンドポイント",
    source: "ソース",
    api: "API仕様",
    product: "製品ディスカバリー",
    host: "Takoform Hostディスカバリー",
  },
} as const;

/**
 * What the API serves at its own root.
 *
 * Not a console — the console is a separate deployment on its own hostname.
 * This is the page a person lands on after typing the API's address, so its
 * whole job is to say what this is and where everything actually lives.
 *
 * Inline and self-contained: an API answering its own root should not need a
 * second request to render one screen.
 */
/** The product mark — the pixel tako, drawn once so the page can place it
 *  at any scale (brand lockup, ambient ghost) without duplicating 46 rects. */
const TAKO_RECTS =
  '<rect x="9" y="0" width="17" height="8" fill="var(--accent)"/><rect x="8" y="1" width="1" height="30" fill="var(--accent)"/><rect x="26" y="1" width="1" height="33" fill="var(--accent)"/><rect x="7" y="2" width="1" height="30" fill="var(--accent)"/><rect x="27" y="2" width="1" height="30" fill="var(--accent)"/><rect x="6" y="3" width="1" height="31" fill="var(--accent)"/><rect x="28" y="3" width="1" height="22" fill="var(--accent)"/><rect x="29" y="4" width="1" height="20" fill="var(--accent)"/><rect x="5" y="5" width="1" height="29" fill="var(--accent)"/><rect x="4" y="6" width="1" height="15" fill="var(--accent)"/><rect x="30" y="6" width="1" height="17" fill="var(--accent)"/><rect x="3" y="7" width="1" height="13" fill="var(--accent)"/><rect x="31" y="7" width="1" height="15" fill="var(--accent)"/><rect x="2" y="8" width="1" height="9" fill="var(--accent)"/><rect x="9" y="8" width="4" height="23" fill="var(--accent)"/><rect x="15" y="8" width="5" height="3" fill="var(--accent)"/><rect x="22" y="8" width="4" height="23" fill="var(--accent)"/><rect x="32" y="8" width="1" height="13" fill="var(--accent)"/><rect x="1" y="10" width="1" height="4" fill="var(--accent)"/><rect x="13" y="10" width="2" height="21" fill="var(--accent)"/><rect x="20" y="10" width="2" height="24" fill="var(--accent)"/><rect x="33" y="10" width="1" height="10" fill="var(--accent)"/><rect x="17" y="11" width="3" height="20" fill="var(--accent)"/><rect x="16" y="12" width="1" height="1" fill="var(--accent)"/><rect x="15" y="14" width="1" height="20" fill="var(--accent)"/><rect x="16" y="16" width="1" height="18" fill="var(--accent)"/><rect x="0" y="20" width="3" height="2" fill="var(--accent)"/><rect x="1" y="22" width="2" height="2" fill="var(--accent)"/><rect x="3" y="23" width="2" height="8" fill="var(--accent)"/><rect x="2" y="24" width="1" height="2" fill="var(--accent)"/><rect x="28" y="27" width="1" height="4" fill="var(--accent)"/><rect x="29" y="28" width="1" height="3" fill="var(--accent)"/><rect x="2" y="29" width="1" height="2" fill="var(--accent)"/><rect x="30" y="29" width="1" height="2" fill="var(--accent)"/><rect x="1" y="30" width="1" height="1" fill="var(--accent)"/><rect x="31" y="30" width="1" height="1" fill="var(--accent)"/><rect x="10" y="31" width="3" height="1" fill="var(--accent)"/><rect x="17" y="31" width="1" height="1" fill="var(--accent)"/><rect x="22" y="31" width="1" height="1" fill="var(--accent)"/><rect x="25" y="31" width="1" height="3" fill="var(--accent)"/><rect x="10" y="32" width="2" height="2" fill="var(--accent)"/><rect x="13" y="8" width="2" height="2" fill="var(--mark-face)"/><rect x="20" y="8" width="2" height="2" fill="var(--mark-face)"/><rect x="15" y="11" width="2" height="1" fill="var(--mark-face)"/><rect x="15" y="12" width="1" height="2" fill="var(--mark-face)"/><rect x="16" y="13" width="1" height="3" fill="var(--mark-face)"/>';
const takoMark = (size: number, cls = "") =>
  `<svg viewBox="0 0 34 34" width="${size}" height="${size}" shape-rendering="crispEdges" class="${cls}" aria-hidden="true">${TAKO_RECTS}</svg>`;

export function landingHtml(options: LandingOptions): string {
  const locale = options.locale ?? "en";
  const copy = landingMessages[locale];
  const consoleOrigin = options.consoleOrigin;
  const console_ = consoleOrigin
    ? `<a class="cta" href="${consoleOrigin}" data-i18n="console">${copy.console}</a>`
    : "";
  const base = options.apiOrigin ?? "";
  const noScriptLocale_ =
    options.apiOrigin !== null
      ? `<noscript><a href="/ja/">日本語</a> · <a href="/en/">English</a></noscript>`
      : "";
  return `<!doctype html>
<html lang="${locale}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Takoserver</title>
<meta name="description" content="${copy.description}">
<meta property="og:title" content="Takoserver">
<meta property="og:description" content="${copy.description}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Takoserver">
<meta property="og:locale" content="${locale === "ja" ? "ja_JP" : "en_US"}">
<meta property="og:url" content="https://takoserver.com/${locale === "ja" ? "ja/" : ""}">
<meta property="og:image" content="https://takoserver.com/og.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<link rel="canonical" href="https://takoserver.com/${locale === "ja" ? "ja/" : ""}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="Takoserver">
<meta name="twitter:description" content="${copy.description}">
<meta name="twitter:image" content="https://takoserver.com/og.png">
<meta name="color-scheme" content="dark">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 34 34'%3E%3Crect width='34' height='34' fill='%23b0301f'/%3E%3C/svg%3E">
<style>
/*
 * The machine room. The takoserver mark is a pixel tako traced in dark red
 * on transparency — wireframe, not mascot. The page lives on the mark's
 * darkest tone (#17100f, the face): a dim machine-room field with the tako
 * ghosted at sprite scale, red pixel accents, and one bitmap display face
 * (DotGothic16, inlined so the API's root response stays self-contained).
 * No radii, no shadows-as-glow, no light scheme — the Host is always in
 * its machine room.
 */
@font-face {
  font-family: 'DotGothic16';
  src: url('data:font/woff2;base64,d09GMgABAAAAAHjEAAoAAAABmRQAAHhyAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAABmAAl1oKhag0hLciC5gUAAE2AiQDmAwEIAWOBQewVFu6U5GD4O57B6pKcNuAntK7ofvCzgwIzgOY6OOIL2Ge9RvcDimgNgUzVVVVVdXUBG88cpXM15epFtTqgd1zqKK2nj1lOAhUc3K09qVec1JPMz6f4xd1dELXqm+t9h6NLRgoQmRTKxRXoTvzz8BJXcQYf4jDncSliKK70qiFZQAlaE8M/j0Ua8aOQtSIxOIZ4Km8vFH2y7EXW96bPl/voi0YmxGbr9ZtPMvFv069VJehdezHb37B53IbwsA3bUPRMoDuYpgyZeu5x77+nvb1EGvFdH5ncUr5Ht8PQx3H3/7RLTobod5REA6WWByDGkWpE+CDGnswVx2BI7BFxFAn9Z3uROA/azQ/juoKNZYyBJ07BuBdU6+v5zqQsc90bjpP/aXjQGu/5TC/xlzsr15n/nQXXZ7Zv3MX/6fZ/n/T/J3GnzMW+3PWAbYxxOpDpMiEi9wrzU8foG3+uzvSTlgVzGVj01Nm9iJaG6MKUReV6KJh6fYz8fyvtezvC7Lv8ot2hYlw8U1D0DAoAyRsXGSUOZBnDGAMEMnuvgUU0NRCGlpq6RhqLlrcIIi1NrMRi5XUSO1VFH9x/AyTRIBAAONsF8oAxL7QGaroJ2b/ez5VfYSSyUiKw8TMpmG901lAwHLx8UGN6Hs+1UW693dVNTMaeR+lC0hZY/4PeMN7n108Arrt9DCbspEwHRMgZdp8H3Q3QW2WXWblqapukhh1TFAInfKDSco/xcX25s7OYD9ygQSgkSVNwNGz8LZPYPqahOkR/QGF0xNKXyTdRKYlFA4B2CYwROxCiOUpHYJ+bf/2KqWdC6o90TNDFLGvwERO4YQhHpRb8P99mZbJ6p3sYj0IrQqyeChyIkr3ZMlR/9diJ/ldgz0OH2j/XslxmNmLnZwlmi1TSUIOmTXjE5uFjEXLV3FajoUeA81rmXk6ya+NUfkDUmJTwHelUerjgeyv/P//SWmllViOJVq0aNEiIiIitrhyP9/P6A3Gz1JNm5ldK/cWtYvSVXmfJTqmHT0MQgO0oxx0AIEjPN+v7eGUvCVjN7wZRORRIklL3xIRL32n4/JF/e8/m1VSWic6hnUeuXUkahPcLFijdxKt07251mo6JpxQa0zeAq3hvaS/RP2PcWqNR1pNROcrWMfLUq+j+B5rV6jXKQtp1vCKXh7g7/e+e35kAH5d80BbB1wMA4oosCYg5raflyyKeMJL98R1qoWA3+dSZ2cX5b0/fxZUVDmKRlWZC4xk7CB0BMfyjc+gsDkWI6Jv4uhFQ2qPgClTrdIe8VhL3TtAPOd49zjnguh8vPqqr/yT7NDdM73TPYMRpzFEAQOQWgxAHmHExwwIPAlIwoBUHUBJW6AspXNr3VlDDM1zAa4hJK0Rtee0b23mbGacTXKbZhd9EH1ogyz7NH//00r/TQcc9dO3d8lb7CRwTnldsswELnA83X0HxWXIsik9elkXXNyGhEbP6FFD/Vf0si6xnbl+mjlOfmgs8AS5zB4QVyvWl19Te5ThdVRgoUzyfzvIG13+MFW7CUdo5Hzb25pQBa+26iPLRkRKIcvs33Efwy2Z/VUzih8H3AKJtFZLFdRlbcEVnMP1KqgEo6iMzNC0d8az22uVcqWhq8k97aFRhSrU/aqQNWYwwWRNalI3ZKPoNllaP+zd32Fmsn+aYyl1CQHHcYwxQihCcX0dZFu1frZXKgtA6GXp3yGd0QM4o/UimCSjqAvltjSrISkiYyZN+f7xHMCg5kYNJkBmkiqAf/1SRASvLE+RJBdvuX0gfzodU5ufJ1B0/RVYjEd/p9bRTwAjneBFHTAxCJBulC0AHlgAqO+YGwiRYZPBhBFzH8Pk1H/iITtIgIMOhAqz0y677VGHRjShGS1oRRva0YFOdKEbGvSgH8dwHCdwEqdwGmdwFhdwEdfpBp7Rc7zFO/pEn/EX/Q0aZ8lz5G3c3QDFoJjUWHvVzGYglkhlcoVSrdHqDUbLiNFjhM7BeQuXP8ieTz7fzw/w1/wNX+Ir/H/+F/4Q/yv/jxHHiPnKBAEEe3ssWCxYsd4bsLGrtlq3twKPIChICcoCuk5IRsWInXU22WafW+55xhPOFBYKS6qqpj/7t/+E/4cxLIZ4jHiyeLb4iDhdnCV+In4qfi7+T9JJAiX/JHsl1ZJ6yRtpucxHFn80kmWye9ln2b9ylpwtd5ePlo+Xe8sD5bXyOvlp+ROFSlGreKqoyWdKjtJMaa70U+5SvoPeBv0b/K9qqmq66uCqqavuBiXUGeoMbYb2Qkeh72FHkV/R/sIqZrHwFyvFuZjrsc1x9+MFOuhJXdY2/lOCRcLS4O8EOnFSWJU0O5of+cRvpkSm/DQmlelr2tJsRzEtAEs2JJvxhu83sTZpN/vm3aOX5uOW37d+2nZm+9z+vx2Bw92dShvZWb9rslvYDqik1frd8d1De/yf37DPuP/bgUnGa+kB1qR0Y4Ey2BmtmcjkZDplrrfnZNZk9mXezVJl38zZ6u7M43oG84xqO7WL2ssrVg/lP8x/XOgV2BzKKM4quVEaE2WVzY8GDjsPCxpNIFEYmFjYuLQJbcqMOW3BkjNXbtx58MSj59Lz6Pn0AnohvajFhdChdFjhdES1tIF+7wP90Sd6CI0BT1gVHqZvWf2b1grnhEvCTeGFoBd+b9v/FX1lL96cPvWbH9/a8X0YZMZ5QzuvJVBUpbBaWC/8a/RvGcbRG3OubMXljflXLNktmtbvpQ24sJP+/Og/kU/6Kn2dLnOSvkyG0C/ox/Qlz+hBT93yhAyU6Bmncvmxxn/Gw+UfOOY+3eSeevquRl0/mO84St+OqMYWY6NRY9ziEuNGrxllRgvjMgPbYPfOqA/Th+rjDRYGG72vXqRX6cX6YP1Kwxy9xMAyMAzjDNb6aQZbfZZ+5Pv89znvLr+78O6SYaZh2rtD7w52fOeaGcwNXAP7bdDbsW9NB0QDxwa8B+bK6oEtskCeKe+QrQbWSsM6vW5Q96fuzMAE0UR01f3+2OXxJHGBuCT8e9JUd1d3R/dMd+mxSqd6tF3Y+9hfx3pk92iM4H5MdKzt2MFj/GHEUNH/a39D/0D/z/3X+mcMZP/Pfqe+f/pa+9r6/uyb1FP1VvXm9dA7q9uizdPe1JZq12k7tae0Ed2V/kFPR8/xng89yvYtTY9Gq0nSdGvuaMa2ftCwOjd0ruueO6LqjR3htdft8jZNq7TlTqtLy6eW4daR5a6G1PrI7JE6cd287Jba7Nqhmn+rn1X7V6dWj06NTLlVPa+6UzW/VVbZVdlR0VPhWuFQ/m85s/T/0oiIc+mM8HclbsXfinYU/q6OzXud9zD3dU5rzo6cEzntObZZ+qzzmbczKjJE6X7p0nSnozFH3h45efh1Mg8vnavL5xbN0aGvd44H3fdf21d6+f+vzO4/jBwi+pr+aj+nS9oW2i3vtmyb1t5vK9rH7QQ/cp/tkE3ZMGyOm3pTbmLW07Whdqjyylf8kouyG+mVdGvK4aQxmSvz+Co+lKqxr3Cgrau3CVVtCcwITavhKWkKNdxCTzc8bLkz9sy9tGjkzD1Hdry8bWK5sBVNBdHRNyokI+k9tPRuWnpfLX3C9o+9yVRRtdEwrdRxPX8NP4PEouaRv8k1QS1f7Nl7XfD28X3jHxAolnySyRXbw7Efwun5HEOcpNLN1F8K88NZjNDvTA26Q1sj5qPpRMY635t2lXc4c7ZkPer8gsId5VBJaVl5RWVVdU1tXX1DY9OuUktrW3vHvs6ubk2Pdk+vr//Y8RMnT50+c/bc+QsXL801V5ar9Wa7y08Z0+wAizPAFg3s//Y1We/74gSUMt1HjTh1bUKtYMTGht4QGnWU+05fSSITZe4oqDpBoaullIjjyh58AcF5CcZsQcQpa8hKQDTkB8GTTHyL5Itu2Gl1yWaizIEGhaRyoirpoCTaOSi4zxWZ+6Qj+lpjpklts5TUSo1iqD/JjsUGfPOmg1pSS25ZXNEJAtMCHmNP4U8CE9Hp1j/zoyKgUFYVSCA0x6miTCZUYSQFZHP1NSBJCnDAXgGJmOLAMi85k2Bqqx0mx/iGZ0VzN7bm3l4cxLDBmeOs+oWf46gmw0pgh2zCoIZVjaXb+3Xiz1Qk/OZciBpvmodb4MpfWTL0oAH1nwmfzbyxrN2fpM1wZmYRyOGGKTJ8aXYusoSZuNZiJ2xLAtlcRBjIM179q4qNe5srQ+g+uzF1FOof7CzgpQsrsOHBjlFwXxSB7Arz0caxqnVAwTU5tjyEWjA0gNPJKiqO7dEt5N2jbdhay4Oe85F7TnQoBVd19bQytgHACZ27PmPKxjZcSmmPx8tGMGDU4jurYqybFwKNYvBW4LhDG9oKctMIQ/gSSRtcCt4AFIQue1gDbg8CevZ0pzmHWdiDa9umGFPTDOBzwWS5V9YkK2s9qiMemAZRkI0xhStwYHsACLp6jT0J+DAgJiJQkkOU8UHBkCMFS/C1z+m4/8UcASEEIXcpq29j4yQaK1nD4OsQq5LmIWmIfqbgKQH7ekumrpiZ90r9XHjp2KBzWJTI6qAquB+JsA3FUVE0oOjT7v7gEHI/0+dZ8CTkvaQ7s7qPCQtjIADfsmjmeZCzbZfUFditWV7FbzNK7pcHwnL5My73lZ2d9Y2LirzjWWc4pq9K6Q6X69uy+MUb1kdfj2dLPUG+YHRzY2bBwHlV2BWrV/Mt/fZAxyGlvmcQroILz4Rs2lfewLIdO2OClr440HpTrlowDFLfS4VdIPSoiXiC/a4Qhg0XApddzwBlKWOri7/RQwdNghXHurzih8qCRxoND2LctvOmq8ko4HDcw7lhv3cZf+DB2VrrZSpVmvf5glfgfIPVV8SMuiC0stMl35bkR+G1F+jFL4wHaOqB7ugF9APdff0OXJOVbdTgxaB/+wTVa49+w4RTOoUzrvc4IHTLLJKtj7wfmx0MHH/nQ9viaFms3DDMXrGVwWj88YEG4k4iC+c4P1zVR7BCdcWPbMCoEGpwLzbZxOiPAZMJm2xv5f5FgD9pyggFvef5gO5lKODYBvQ/I1oYd6jdry8aWYBX9iM6/xDhpqiBflGtPUl8gSEGhiGWUaMNvQgWCbSrBxSyjnN8RMlQdqIjzo5eSPxCjHY+vw5cv9SjkeYPorWLimFZhwKFB0oopmsyqFjye+wr+pl8oXOoYusLJ75SjW5YlpCZkB6rqw4dIsbBifoTnrxgdmrbGWobx5uVDF9ecbjRcUk5VBpkpjZWrsmB1L0j4qn0pUIyN3vQFGYyD03MD83wyIJUutE9CS6SmxdbFgoM8SApdG9wL1A2nQrZkxOq1FX4TMTZx85dOxpVyu9hHndi893mgaKDGLx9Ne8hYmQzb4zooGDE8FpcUmAuNwndxVZmn/6l1FeQYygteeBACrMZD8RXeMJQcR4x7hHOoHpAQQNUSkrCpxJOfNUnYEHHQW8B57EuMOFxbCXxsV5x4aumoaAo8V3xz6trBu/yBfjPn9imveQIbv7j9EycO/kk+xykmNLU8QIg6rZJATH8di1Vy88EMEFDiODBrOiVyTdkwRXkMKOemNwWHRGEGQjNfITipngVWL44GvrcvhGIjQzh01cET3u0ifQjjRabMHwnmIoGYTsKdDBChs49NtnEZuMZEmgdWAQvez1v+2h4rtyRCzPtwuRn2ll+QGToH+7APxKwpWLA8jkCD4rlihNHfXiaZwX4z/jJtAXYr/Y5NIFlt6Bqg6YGA9QitSG5HyT3+zfwgPPPmoNqr5WMAmnL+tNHwIqPGZwL0J1INUb4nYmiSYouRMiwSrB1XIl7qdhDfE7YQ63TxLZ8FmiTapmuVwmBTHLTQTFlVhyfY0P2bv+9BtkajjKipBzYGAJ/IPaDFGSZt8PbFcd5p81BTVd0kdNEGCfpintJXvicer/HcV8g/SDocr8CudkCpt60kCTsUWHJPyFbUm4jF4vRhwSd9IDnCxi8CexxYQt3mOffvTnyvRb4ywGMeedejIRJxZBwNwnxaPmzlk5+YjQdhFuJsyHKXTDgNsjNmByFb6ldQsASuhbJd5D0tEAWlshsLJSiK3SaaDABobLyctm/M+AD7Hn5JZjB0IN9FJRj3+cwDXKRu58d7VGjEW4dWTko8VvKhcT/KlhCngY/QgEiM7ddkk8QxQNRBufGbwFC/jiOJHn/ZCM07FlCYX9Tf1892lrgmb0O8Di4a+BOWwmxCwbFpPJbJ7XWuUt9BA0S+gE4yQhpG9gg9owYUUooTVWcpogToYhiHs3G2z7kwp79Q6mkdEzJCBvL82iBIVpnvww2/aJ99UebRiU3fFy1ctlxCgFZWX3lyDVtIsTCBwsFEYZI5DMfw9YEMm2MvaZSFImDPcRWvZd+qF02tc7JbLHvofEzTQf1e8eLg2gSS6Kvwv0nZxb24tJf7i+2BTblO6DZ/3zwDk/ojOQuYBj0+yT9MUwH7tcspOXlUZ+0mEPO/dAYkE2Q4HjCJfEGykhn238IQC8XPztJ/dii0SZ1tessogB72cH9gA80Qwo8h0SzlRWUH1omJG8VdFMDN1jttGL+DDWYp1nRJVrt0dk4birlPOggsu5M+3sQ6J6MMaLuWVskA3X37XCUlmQE6kVqs5IGPL6COe4q6arsTKVF56KGyt9tVpqq6JBuN994GkTSwSvvl6RK1Gm+npWF2Amm2GUE1KClTaoF2ftkwnPKu/8ljPKdb/4ygsFhWpUdNjse3ttFlzQ3JsUkwrSMvo/9Q5QTFCZc6xTDu1PCwfxjx8jwgwl8bkLJYphh8yu64qhUIu5MI/nNVAkkXiwwLyLSKTYGQQ6zbKtXeHq4RvaQq6UKbB5yCXnbn21LLClZulQUcYSpnlWDmi/5DpSno+77XEnMW3JeAmmOsvzvj9OMFUpCVPkdpmCkrywwbCcTULS8YPMas1ukuLBCEayVh+rsHX4FQSDlgUkMfNQNb7+nqMjTno6UqyjVMACJu8nTZhHNoqzCaLURaJVlKSiXBemcFoZLmh+pawswyVK826AZWuWFSffo8WghoDQdfV8/32H5d2bjYxJ/OdJmHl3z6gR/M6jp9mvQoX9vwUZiiM+a/PpQ/dl9pZ1rQN83uTbU68ZR0uiDcanEdqmL8B/4jmHDmzQLK1W4rBVmkZEPt44D1M0vQzyjOwcrujo+EY8C4OFgbe98fBGt1/CAICKCE77j1NvbvRVfjJvPGdd5xjxy9FHRoR+2ij0FEjNsrMrL0CfE1YKQlAjz/lzyjqXcDWEN2VHBIppZ7RNDSBj83T6ISi3xMs0pTnqt45rMhx7WolhXeMocG27jHhi+0F6UIlXY+ygD1XB01SdfIs48Fx9CreHojRwnPTwpYbRSAx+zYBHzIoQ70GnGiiVk/jFD+kAYHK1Rnf/01Gi1kZoUqIbsLyiRB1Vp3HuDz1jeplzFJMUj464L+/VR0erjarN9hINvkqokUJfr5PiCzPDGoolgf6RmXUM1irKKpjMJE88C0V+tB9i8GZf8xPs8EqwGq4rT2ay4bZnYvi8d0+RQV2zYeqUZLRmuvxyzhrBq+cqXnqT7aMtYnT1cmLSHeA2oRulHstryvuJgsf8B4Sf0+O20XSvT9PkvnpZSfUwVBD+hq1PXHw6Zwk6HOrW1pPOurtI95DXs9Kg1M/Ufu+iclkcfMM1mBa2SlCjwMCnt2XN8YVSjc6+bRvan+P9x6N/sTyWTrshxKdUYEEdfvpECSqTKoZIwuamiMLARJeuuMfsvjQCrWezRpEatFSV+7KM8Bl5DNgj5CvzF4oPkrN3/iQmHA3rHMDXt9Wb9nlMNrnbf8EpvM0SDrYChCq73XZPFE5joAiDUQ2Fd1/M49xn7O8/2bdf0Oxgv1v3gmTk44Xj4/i62TvCFUU5238uhvJcreZiak1h8BaEcTwdXEtQ2t0YHbSxr0qhx5DYdZWnPMOmWq7yPsD12d0OTee7dlWyHpSPOBA5EN0KLw/t1NHo3cPAnmdsbah44BZjb+/bOYKd/rN3V41hBxpj6pqrbb1IttJRBTR/ECc7xgg8Y+imvLw/Q0Hw9oza6spEPletJIARxlttaZ8qeSHpFJXJ7TcIVZdy2Pp1W0eFXtSIff6HMjG+3apafcMgdqhdx1kUhXVGE+NyRonX4pSR/pFVZsOp+Csxto/w95lBmFohkYt/fgytyUa1PgVdLGO3PNtN4Fd2bM3oRHNXKHI3X46UtJ8kKucZRJo1UAIfit+LC385c0BzVBHVKaThpRw85FjxUG7lBgZs8ZIVFILvMtGIJFIC1MCpC3l+Hx8hqg0268gGOgTc9CuQw5qjogjKFtI1xCRNkpJBCzPX2bjo+l8ZVnnB2ejwobIxOJaVNGEOCjvep71NOunJ1FnDcC0i4jniIYZCpj3PniX/iBVQmamWgqcu0kRjfaoGdHGZCuD7uhJCynCCmjFo2AtcZgNsCJK+eJYJU8RRJ5tF+KHRyGoqC2hjbYfrwrNu0VUalWmHbUmYB/H+HYnF4RsF4VXk2e+P1OznZP1jRJD9OJFXjCdbxuLpktJVT5Mc4j/txCvw4BcjpTT54HIh6gaf41E/Yla/ueqo4l2vv46CtCRbAZG5Sma6jguospr7xBC0bjfrycj/OnSNPxKwIbInjU/rn4ULEk8deipn3y6Hzr+pjVdZ1ZeLmuf29cmFbQFS2OrbsN4X25QVqF9IjkESXysukEJXTZ8Cx/qzapSd9cX4S/GDkUwR8283kIoTq8kImd3n+imH2Dxd5qNwG93c4BVw3lmfsHhMHe10lwXnETX6AQa6Z0Nlq0wrRx9Og93KAP9Evl6fr9W34FhQcEHNySba0DdcVQ2L1yMbcuwAKKt7eaaZ3qKHIzcPAitX0iYBwWMlUIFpgVAZfr0HJ1QXlgDp/Ww/H8dEw3QU/Y4VpuEa8c8w+XBeEWQ/9sbHI62Om3qtbvDfvufmTcgIDHbPOwQWYNhqUXePPvBKA4liC0aqiD3ZHcB3CJp+uS8zVlyNxShz6HfH/JQ6GcbVJYbhqF79xSYvtzPAB7HtPxp/aDVUZ4FPeYD10mz7z3IfaH/2+LBwpyG+3ddAAZ69cIWFuPgN5rHl3sKzChWWflojmEZqtLO0dfEm9t5bJgZBaHiBovGfKx4WbklZKg60Xj5MKdelfaCp4CbHyqMY0zJcKghSUeXVlgTWl3lGSqNEU0GmY7lMUcvFLJ0Aa1mS5X9NdOGLa4cqPJg3ei7QByANHZiXSVMC4+9Q8FGEsvGmhXzsB7ay7r7It7OPN/M+jh0zwO4SOZlw7DJoLXIIWom1NT/1c+77knC8ZcqvzCzP/gpWU2Yrwtj5gVRsmc3Ey5EeaFhdDu+vBrBQ9vlyBy2hulu5HdccpopBENJXKqO6QyNLnF6D8iaRnBiX/nd4sNHu+Z95tHtu3/YwXK/VnxBJwvrofYM8Lek+SHcHH2/uAFsTx1u80UlWwsjVEgcqk1tfx9ykhC/5hDIgu865KeEK/BPgVtzD0KyPNktXrCklZtrtzDRjoCJRIDDhRKRRto6yN/yu4C1BZCEtZc5rGxjQn873OJCh+ZClWbmpWC0sIuugMS+7GnGUIBUhxM7hxDNKjlMRkDbNdX/pKaGTqcN1Jd23Rccv4BCGvMe4uQqdJJ1SwdTI9xpy9ka4aHCPjUQfxa9oy/45BVKHwASrIlPTkPITXpyEbj/I7m8Wg+vGFNnQsd9lKlj0MywbyLdvDbf5pZP9rIbprzpaDooUQ+nMZl87Saubx6G3twJFhyaXhIx023oIQMANNgxxtClA7VFNFXpKxzcuzJJ9qkafiPY7kS7nRDaedAsq2J6GYLpWUhnwS9fLaOYJq3pNbgfWGPHNRZvPTKmWMlwaDeevIwqthKaFrVn5ckZkiAlAjrbE2rWZFreshqFROtSxTLSopM9Mp9Vz4m3VhK4gYsN0imZOU80zrQHuZNT25o2I8J0surqMeSF4Jv7VA3koFrbLyA7NB3MG32rK5/6ltcygTmL9/UfZz05VdJbwu5K9frqvlQpE0GendR8UJkmP54gyKqGup9ulswcQOzJarkZZNWTHvs3BwBs0gxUr6hqNxtGhw1DwR+Q6HbhuxoraUU1BXmhOcmS4bxm1JEzBpfai3NK/RlY4i8pA35RrlCgpd7itU14jJsx9Z0kp6BTSADNWhmCxbF5Ce1tOmmKRQXK36AutU+2yrTuW2HQVbXS7ZyO4IrHVzb1NTq2ZB4MOO7dQR659tTHX+O5ipOezd7uIHMOXkUNjV/UwSjoo+hCi0iRInrhhID2f7Kx8xa2HJm+vg53pePOjrfpzAnRSrC5+gufZe79UyTU+v0mq9ZEZX2ZKS0VJXBtSbe2q0auVYHvkUWvKj+FDVqoZ6Iypu5k52EBkgdN7Y6uerTvIUhz+rkEtxXtlBbzUlJ7ocALTobj3WEgoaR3UyaAvB5ALtnRlRpXkKWVdBrXgaM0HDJXykFE8BuymRORew7gayVg3mhlemfMFAh/gFJvl77R4/RyZV29HGQ7SzxN7SrZM97fPvnGIGTLfOBtuv/pMiItR8YcEwqKj8hVDh2vHPCtbmBGDf30qU0iwRimHuEsC/mu9NxVunSxoNyPOjTPErrcKyH3LqiIalCmGEBO9+2qvMivYjvM8ii0fsIqFx/7U2WHE/1XbNXVKYCpzdGbtdE0AxcBZ0EJxFBEHty9yZ6GjHuUNT0onTWACoZe2UEYtSGh0weT4OSyGl8KVGfNZuG3GHXF50Ztqh2f293UcF0OkIvkRWa5C+JCpFCucdfG9333/KXQj0z4+KKBjj3r6Xedhomh5BAHNK9UCp4IxviFmjPnsl5PfzLUmS80cPvpqA3sVSSVqheVY/UBN9+Y9vU7U3nr3KSVDDqNfZT/wPeFtnw3j6Y5AiKhWMv+b0O6NFts9RHFW4TJf700uEBpjtuyLW3/aTxl9lms/JstDSk6r3Kn4j6RItUL4EA1DLjZdwdzE1JT3I0HA3//Fi3LfrZ30so3ft3/zPYtLoWG+s48m4N7gbrACnTuY89zSLGyS95mPBNAnzF0a/cfjBOTsipcSJyVSY92hLwylsxJBIcOUs9h4o1AHBDwVK0qlMYTsEG7Rm/mvrXe3jXKRjS4Ui5uKViwmi5rYfDyhG6B2v1db3TfRb2yLXd2btg8DEv+1qmZz7M4sR/6vigWjSTejw9wCUDAveXu0V2gyv66SOzwbCm13I2Jx9t1b6kz0Gt68BxljaRhBMNpoZOPwF2r/dvaoIN/KiQ2bh5rfJpPKPOqrw1lpbUFNRBI66BdGWz0OBV6TbZhBD4XiFmnh7uWMQxB92JqRf4TMWNPgDMrL5Mkws8Z2oEhzrvawso/3TW324wjFCsiNIeIm+PCEGMZ3QzKSj2Y9pW/AEYlUnWUYDRaHR4Hbb7Ft4s467C71hXPQqaGoYkV6d9hf9Pn0YDeQHzmxnFRmPerQziDZB9UDhHtXUCO2QiAMpgBuHWUZvBuDlbggHIexOeicpPRYN+G3hvTJQacfp17a78OQ3PHzj9YkxjCYigL/vm53tQ1Gt3az0ANKCqKnbysf8kAGgY6lXaq/d6bULIGS7zM3rTn8XwZtg5SjJjAfJoHjB+XdShPO/33vqcWp7d/8hDDADkCZtXI0LCXAi94df9wbPldNnPWnBIqYfqT+qJgxSjBrwnzELOwJZIzRAsS2pgu0gLnu0K8gwspsvlbFTF0x8Z2OEBy9NaC0EqfjOYniv/eHNcsw6J9xJGVmYX6cjpLGlb/IsLKEsb3+wsXYE3R+C+5cDoIpVqWI9kgJaMycxF3gjSuYTGYDjXlNI8hprBFKVhvDJ+qYOX4yBLoPfuQ+mJh3pkvYL7FFdVShyLfQDx3QCbHeX2w4LW4kP+fFH3IdUupRLR5wWUpRYTdm5gI/6DV3gMn7rDECbkWM3feG5xvaA+YbOy6YiJUCXK0WtyEbrGlbEgHt3q1xcDPwRhyxyu5ETyFwfQ3HFo2GQnlUSPfsWbPfhlAQJx3nevYZjY2DoJaWLM1Ovlf0AE7JOcylT0hf7FyJpA5wytdRYS/7YfUCV1PkneZFTW9JOm0j5kWEVXTp+6ry1bLfXmXeYjG4yRZGfJ2J1w3b2eqk18sPnzlshkyQkgOyhxUit+aIfawknoAIO//hvEkfKvpd1xlRhWUXwHNvrQ8E4CwJVciDDfPFgJVgRyT56IKirze/GwLkGofJcwbHLREbUlbv98D8ShkeEi+FnPdpxTQMbsBhMUPUBbuKkA7lATKQ//ZhqCxCCzjMlKKSdohD44Fg5xbfwPx0AAOj9Vyg+dKD9SUplxrMC8AwW0q1rCqjsnvYt3YbCHQEN/4bZC+lCzJ0tGjbNeQyerLvvIk9/kNEkKc6GKbWRvGzaiIaqZaKDkL6r+xmQNWCOBxDvOXe+zG9Lw7+tEYR938f25tNGdTFdwy2826PoLpT6DOhmGEEzMKTM0UWf6hOrmG7cLbcvXgfmsT/hAqwXy4C0epmssDbnl+ftaXsRl/dBi4F6SdD8CMBpAnU8eDV2JgpMccNwTKqCsXlTD5jOk6iBPyCfJoC+yMS3nywR97A2BVy6C+PFCZX/xQuYt5T67h2BUAJZC9tuKOUYZP+gBs740JO9VucNwYNtD6Qhza4NmKRNijHSflBeXaAPjbri8iH1fVNdnq+1wn9DoCWNiNoMs3x1IqZn8hqKhh3jFilwl7flViNIPsCc5PfIAGp9G8vyZpjEXoaVxcXiGaPjyglgUG1cCJxKA2IPE0S/B7K4lbsSsDr/tO5AX5nBOyKaf8KKec5uEKepcAy+fKQS3jirzZmHhfDbB226C+zwFlrnEPzmnobt9u0mGj9jKK3jU3PeEDPiSAYHThKjGaGNw9rC6wmPd4zNG6gLRMwv6skTUJxjFMCcJEzJmUi4oOe1Dus6SNiEhh/8UWXiyaLss5r+vpzWxu5+JucGrxHf1oTxLMybw311GEf97ay9NcGPjMaMWWM0XD9SR25Pwe8M8Lmv1npUfw8+4PJZ1ucddzt34yJF1aOEM4WKqvNXQIp6Ir/g6dYahaohqDcOwDNIrcuR6aPgECYnNpunf8Yaq1Uc4WpYR9IkIwhp7i4LEpdJCHeOxhDV7sX6ID9dGxKydn5WTOrq5nFCle17WQ49wdP4kL/k9eopSpOHEm61Z0tMbdaZ2b9J5/fQEigLDE0W9zpMNI94PnwBTAWk48nCuLG2Ug6SyQ5YxoAzVBPITruOxFtayix6vtkwI+7sbO663lbILaDW3ba6yHGO5BlWcoLb7xOs/vyunmYR/6XyHC2lou8srAi6OfFaEILw5tIVfIgzS0I7P98Kk6wRxp08cG31DtdqeN3Y/N8zkad+hYk/DG9x37jXoZaGLNHn13pxtbZC75KIUzJTTkAuBiCFqsHuHD3WQJNVTYO+GVK5OTKSoR2E9ciz5DKNcHZIBIumckCbWVj0B1Gd6C5/Wbs+JxYMLEG7wXhb5AWu5wZOO3GNWEaiTd45CYKkcIMz+gLxsd3KjvFBhw31UBeUDs/j1F5dt0g2SgaXDuQPOjPb1iRF35/QSkD8yLZZHwE6AFalYn+RB3+PzPtNT6JxvrLfpyk/yThWwb+Lha8sQxIHiwj3PcszcYGXYKxXSQj42CxkBCso9LYk7dd7Vf7grOzksQ+ZBZnHjrjebCU+Uy/mUn5d91xLPOinFD+nl0P5qFCFdNtW4iIuyGRZLwR8m9+nYQevYqTVpZj39qCS7atLZLEaxMXSZMLgbVQE7hCZONZm6BC8KDbcWqoafRgi5RPUuVdKP5wmy3PAOuFQVuQmsLn5uKtbTnzpLwU8y4k1FF7xXp6OQJB3BEh9rR1n7xq0bWjc0tNOc/7QloVVpf7yUANsuKN3YCiS9AwR9yyJUq7ODCaXUtvthy4hPmeNF9BRJSqE8xKoVNKGQoSsDznxdrhXpQrmTnNcsXHTPnDQ4tn+XljithEBksTKsa/e8b5ojrn48CLoaVW4BXAv+HU4qQT4ZSFSC4+Of+zTaqlAAKXFly2ibLSw/r8YzwUYCK2ewcJ0pDfD+yFMFGAtiMzvqeOw5w4ZskIxsK7cVs/PUq9c+HxKintnEiQ/CAK+V4Dn8zX/eG1xkFhlzVaUiDa51K1fdbi0HpC3YNGr2lpNQR/GDQOMR4puW5x0zGz471y3TT+fajaWbLjfR5Y2upDWJnQ1JYUpKmyVUBbEn+Yxgh5PTj79/VSobU3F65KPTbXTfgWtQYqEHslK0ZYBm2ShS0alQ9aL91OpltsVFjiuW/Zt2MlVE3y74ZWSaIomrx5DtXsWyl0JiFPvd2uDlavhlcHOD0x5cWKI9wVyG+4lu9/r30E14M0EpraFhzV3CeYuWZcLPqpxu6bTusW7YSde88UxtBDsbYArGTBu7fZs7yuWugLbWZENuXyPcflyFHeyupSCjKNgEnhWBEZFLCIvsXgit47L7wfpNOI/X3h4djW52/lG5IWcwIIuF4MIY/WWFVyoHzEZkH02KTjuquIE7ptRiIhfuo0FOuQh1RuiWxiZJueYbVGRuVjf8ISkEM7me92Ij5O/AENVWhXdFSOyv9yz37hQ9zeJ7T6ccWUqaBJ/3hdVhwtwMPL79UllfM19O9BAkylvZH4NNiHelwVcNxLtk/RksLC91bYiSWo+Ub/LkDQ3R/NLUGmrky8RbYTCKGsCTPM0WlHsP9M8wpoSLSNB9Q2OyaSh5KHcbzekDlky7ZZx2jEmtE4TUmrbS7meFNZerKSkEGzkN84sZJVnqCDZzmJTrpJEf1tIhvxcXdIcvimtA8ESV1gIq5d8JX3ylXp+8uaNm40RIgTlagAU6EqDQPaYAxxUvG0iQIXAwR67UyGQQwEuOFO3MCBlyUtN1O4f5RRX+iQl6sHPeOwZChL2nAQJJ0gIFUq0kVbQ4pWUQQkMihpc9+1kUaOeeORkuGjZBGkNC+rcPfoS1nUfdyY7H+/SQVrdBlfM7VmwQA9JtzlDMVdiCjltthaqH3q0z0E2qPPyavp0+kWynLOeF0ttYaLOV5gJ6Wuka9IcFWLOkeEqFVqyl/MOvLJKQt3/dkh/FAYkIY4w36pbOCopUe5nsEEPEmOgC+qxZFCZfksXNCAx6LHBBiRfDV7xQAF18kmYFu0AJQYqBImBKBdBYqnWLscSJ5JYsT1Rpt9BU72A8ZPn4NAqRxWeVKtVNTiBUOAEIc9VBK4gcFZJPfi4d88DGklwD6gePfzoEeqIA9BBB+rWr2lu7xc1uO4BHEQHOqj323zC2AYItA79VZmOxjekDjbai4XvHsuaajVsc1tVXx0o5q5QSPcnKNHqfvSJJ47M5o6pSR1MPthOWhXLnSnOp525OpHjPicYIAimbQHkHAnGlnbqhToN6BFYmVerCPVOQfoRRtNAPY9hj7yIzq6sI92lbs81WL1zoEuoF8aWeJ/dB6bLTEW1PFir1jrA6/8jTY8dNLULIPvqwcueeHBQkBg44KYBLpbsGcCrg2ejHHVRiqrXPXIgzACcOvlwgUOGHPB6qV47SbxN824U/4F55BqQvkZCIyHetJw/UzujvMfZIMRcXyChz5Du0xE9ovksNztK37M84NEbPTzCEeY2yh9D5aV8+snp99O5tBqsez301ItFT7e45la65bupBnrHolN95wcOGdT8AXd1lt6m3wpX87ApO9DsyMBuILKUezKACAf007QZqxym85JPf0Frd0+47KPeehdLamzu5YfpkPdzOV32CxrfL+HB/Rh4xhNemh3gOhBACqM1pxzpIXeRhDKt7LOr13vWg69pwN5JMMDTfu46vSSK3zpdSEjH9LBNrHEPe3dVblm/IhoSJjPZF3x3CmzdgkVOR8Gyin5eXhwaMQG/22Z0sOkU+o2y/1q3BGhIH5eBQbdoQFWx9sexrIp90aTf4KVff2wv7MPeS/kJ7TE4MfbYcwp76rHKkeLjIY74GUvoVnrYO5k0glvu4dZBV1aDE54hZORE3ZiP2lz3lO6mY7lyVssRTtgss1qqteOQiXr0LTTZcxuCI68KHqTkSyGt8haKUXPjr+f+54+2We/TflsNrsdBLNFpy4/xVIsNLNuWtGJl+/dpbr/U9tXBQYS8Be5smJa5t/rBfu6ySv4YqMkCSs7PT9i+sWH8qocJ9BRL9gKv7Xn7PaJsLKjBNb/nYIREMHs4nl+tUkccvtFDfacWtWCIZ8YppP+nkbgGUG493mLP8a55SDnbdRjwm8d9AVMPRb12MUrRQBrZNizbroWMvCcxPoFdN3+V2Dt50IKaejbW2Gh8/DhIB+qYn+Ulefdx6as31qQmjhwQdet61mOZfAA0PhAsjoroRzUBBoI0xGNuPeGL2BI1OOjDkFCQwFe564BL6Tr4mF6vU6Iy0XB9o7i4UOIdMMJavtvGZUgnbonUlGkzSE9zi/UMXuz+P3ZikBE6sAWXrAbrvk6v3dTavIaGTbrLgxF1Xdf69XFs6ewlm1IfzY2/6I7EMz5g5nz1wmVEgD81zCRCnlTOz3jRsuQMJdw+OCWO2MQ7c66Ridc9nbtZXO2cDgbcxDw04/IZCxbPUL1Ua/0BOUMksKE7NhA6kCRc+2GgomSqXJalAqoQW5cjOY6MM9CwLsFwrv0qqG4hJ5505JAo208TWD7TCa/25KtXT5BRU22DpG7dh4H6KjqgjzD1PatX16DEZNRWszw4vcrBIWhQkKQeVW9MB5n3617gRTWwRxK76NrBypQARLc9iL3nmzY0wLEGdHJ/yrq7OW28qpqZce3spSP9uSxbKkOW21T/qToxMUBkHFR79FgltYVG9GU7X0b1P/AY7xF8FGoOm6Eui8s4lH8utfga9GDRGKXvWI+iug0WXbKY+NfoSNX4hOzGVv4xHPKE0HyHDXbdK7NGygxDW11pQ2nTozKfIZGBmEskJoRuAoCokIJJ9o0KZVqq8/9fdY6MmCPGeDV9WcogAn082YAIWpVVJ7KQqCSRAWHlp3OgTqpvqCtdtXyyVquptb95bLCvPsH36r3ShXUNjXf100Zl/qB6wdFGhe07YLiqbkRliyr8GAzeEl7h6t6JrG6DlLAgyflnhTLV8LECvRNtQMnIAJgBvX7Z66SWp2u1WuXj4L20QWw7li+AO6A6uBblqHr2D4jMMAMtS6XhWPX0vnW/mDFqD/JyelmwLf//e/M92RpLH1kqavq9yDBkqCEGFWc0lfNO4JzqIwqB5D0g9/s1V5P3CLl++ShX2mY05AoVmnFwz/dr/n5On/4It0lTy+8dPd7Sz+8nfaQRNNQWRvBm4zQyg4c4whegydbCPCWm+gteznt+fNGYbxzZXji9oF73HDnCMN01Sun1TdUQBJb/rweIQxP2RpganDbD9dZrgZWPo5GNCW68549ShXlcMIGoYFKaEDL2gyNY379B8H2To+0oHkklqPAZNXhyNcW2jPKsH53H0aNwXsM8j9rf0y7XWdfOk/RHNk/6lHT8rtcSWJeVI41GQ63tiyW2Yr91zq36q+rEFSCiNAzXAC+lJUJYIp6a/hskpm7Sig0aSHKsB6OGGJX/jJyTxVH6D5qLcESx2F0DLdH+dYyea/7H0IIy/X7VvnrZkkPcL9jq+95rJmf9Rp+oNup37vjlIFeQYqfPYqaDnLUt/2BrHdiCeUMScq273TEJfWLyWXk2OI0s0MPuXjNPNg7tBSF+4MCAUlUjo6CnwXLoCwgsk7NQJm+5GBw+iPPBNUjkHwzJQcJNG0eQ4Yl3nhvI8irXJ4OPMBccrVar22emo3BBZMiZhmjxuwgjJeeCIJhsAvWj/Ql/+6D6MzfP7CLA/zYOfAFSoSUx+qpv+m2HmKfnNfHnMrcxIRMbc35X9U2/CvlDHkW2RWMoRsqjzFVDfQhPnHOITyFT79h19Pnq8z8445fuz3XFwBs1Frr1e6Le+GM3pP9M1AmtXwkpWtkjy23f5xyVqlTOcJX/aZ95rAA1njogIXzu46P3Cc0PRvmPdEUqaWdD9ebCg2hxiqXjwwYSeOpNfuVFKKwrbPzI4KnB3ZmwMcj6LkIXFUPR6aMzH36jondAgViKR9AAKZPBzNXxMB5gOdEREJmjtWotWU1HtwIoSqKmTgo1fUrVNnVqVvmUZBpVA19bOKesDHv3/KxO+ErflUaA1LUReZckOijRyCdJEhSkiY/uIRxKA/yB0NbirW9FCWYRqXYN7iK310ygkJ4l9pHZDKZV21m19jWCfpyE/ZIl5Grs5MyXrKaaxTUYC448dBbCegkx1yWV7aDC9ByWdPwH/xgNvv17VDgIgmqzeio+4mIN3Sam6/X0W5EkRxLlllxunZSDTxjZtwFEMWKvp4PVrYO6oFOzvZ5eee7JBHH1fFIOdAMe7NJ7nAhtUPZT403nz/n/6YgecsUR+lCH+t/pXg9HwShH+EvnRofmh5rGGS+IPBYDi1IuQpFrKae/DLB04nUUK0tdp6EUD8tUl/NUBvjfvjZ4pnpmebIr3eVJ76McAc1xlUNWD07qp1ZNnqZ+26CRNT8c9UccNXr/37098s0wMYnpp1IMg56qv8KhWkifZvUbb/infS/ND/R39B27cvL1FLxyucYSdc/RLnddUwNPxEFB3Xi42uPOS+39wtEU23tFdfvvkdMpX5nHLaWu70ikavpKu91Wr0cSoaufgOVOmVcjQg5A3arn+jXO2ToGp4U81aYAnJVY+urgugeQE5CEnO+WsoO0VMv9wAm6To/HdGRjU3AFNTS+ejme1eyxntX+lPfs6hJzT5PUSXePc130vQH4C3/juxgzSTV9sX1r3Mfq9d6s5dSm9lfVwYlCl0iyUJCpp9krqOdcw33BjMcGYaZKZsmtUSraPxEe2U++reqnr1DMS527bXLF/f0fR4r5OU+Ry8edfesmc1wgxhzIVIc+xks5AHV4MKtFEGzTrj9l2qtjI/i56kbd9vZjy7Iky2z4XQ35IYVOl2UrOZxUpJId5ZFfmc1pJRPaUxpG02/Ks5btlh7k+4L/Wv79eZf603lUQ69uvCqvJmyXZXljS5bLXHhbvdYPSfFCc2EeHfcgC5DPB3LqolspEmhtdhQPfWX6MXcNtP6yBfrO6Wl/2O6Xih21FKrFfV8NnirfVZbVLcarymTnEgptv+wedrXo5HDyZViUaY8z6C79vlr7ZYLMALLY/4kkgAE9tzGQVpVlFsESWCJzf1VsykzZL0/tR+jQ48KWo7mLUdRW7sNc1KyTw/ZJvtCmGN6uJORRTuPtq/v9g/WcmIVgvVaMQra4QfWmUbHNoGH1Qj8kOiDM+DXPYs82SWGYtccJre/mDdadBQDVg/3AtYs5bsTSS78M76zeQlAzA5ocIez9aMIp6hkWTcjwMxM3PR0+MLvhZx6gIEtvX6o5rLy1pza78CnMe+re5i4vx9SPfMmuc0fZhTfkqZkB177lEdGRrbniWrY9OKheqsHpKZm6y6qEh8tQUGDzeCCzKGVebTseKGQGkNAA0qx7AAeKY2U7tbwGCcwjA19UCjFI9WX8H6fHjD0agOVcXdxyCjPa+KUS9mjF0B6LlEBhk6w5mATlPj3zo7oWQh+rR1eW1RSGjdk3BLHH0k+mAB1ao8yTt2We1Vr/XenQrWZB4+PK63GKYllawTXHGDlx8HCosw9RgFPKstpGhJEuopUIVOV+WWOVawg8VyuVKNXo3xbhsa4h5Muqp1lVt6Gn/eige7qlMpQfdbWHDYWu2RuqP+0RHQt19iYKpi6ifhLDRftBu75wPMrRNspTYjcSSdIhWs/XLr7K2j3s5vCNVEK0O1PM1/OnWL1eeKwgU3VwvqFdQQobwhbUxYs99uivIX7E1pMYCnLmyecRdm0QTvCcd35jIve8Z7njq/5jA1zPGbJFnE9PWwIhkzk8Ynq2G951rjbugIhZEMGKommr7WdvWi9Lm4+nf5ayfurBgOl05kefiRiaN1745SVAgWrt8ZyfMXB7M839GiBpYZoJB15/FmWM34TCE6lmQTWSMDtC1+Q5p3vDLq4EOU6Nm+FZON8Ih71qTldr1eI+2vDEtdCdcdd48yR6Cjp2Y2tXEsGHQPprC7yXfJBRv/3tPIerLpr5d9z8ZYynJoz6Cm9YpuJwTVuuXNNTbRn2onZIavIG31D4hfv5BqtjFyGyAFzbEGZ7DNiTqsYjvPmwEOi4UnXJ1XkJn5ZUxyYsIqTKnGHjDmF8oKdo1LhTsN8U6Phq1fDKcMNIw41X2+vtcYUUXxeBst0twHrCjBFXeuiQkyCSOa86ASppGncYpxTkWLFHEFWpE1FsRDkCeLblVPU2khFoxGMcX2mjhR9vtUH3ct7JEnPZG6sDXCsFhBZyiHpVO3x5t4rGgynhnCBCU0Wlz3alqz53Q26oD5xtSUvp90w0SVyIbR4z83NYjbDISOOV92TtkGt3ZbYkeIKYoqKTfiKnJlgDjaUYRgRehrGM+pAzyTd471/d4BXUT709KTdE6bPr/5m1ar4aVStniXX+TUycoOjAUHAB91gyqAlVVpw0X6TVEhtEH86YmKbOgwOC9iReIg4gAPfA7+GPnDvax3af9ftUvn+f5dRLKV/NHadMMZ/Db6d5EhNXSFQx6jncWXqHo9/RSmftRNAhvgrQR/zOr5LavJI3c2xtqJZFOXpW+MIrVKatt53cbTiNJ/8OlxWqjxk5iDyEXZA9RxallXOgCALC7tizY1rsd/peVnnD/dHcPXDUG/WL7YrUjdO4rPSErbdPey/ksvOADq2ZaMAFevK9ypYYLef9keermbN5V9xr4ZqUs8qefVo9mbmyxEvBkiwpfbaYAFMw/AtkRHmOynbEmz248oqsWoCQaiQ3anvza4CoG4VfhotcBZAe2VYYDksFtLqaWc9rlhMHIoSFAjfQ7O+TM2+EZIm42k3uUFr5rp7ZoHXaAjQSUI8MF/AjTtnrY8SOulvvAZk3XYMO+oPyErCuuJRFwQpIxycoONuqggDKGCILHrl2nvVoJLVLw0misxI7MmHYr66aNuHlJrofSz7CrhKRqgTqV4Eler7CG8Tkv1QV4g5YUN/xMHNEw3dWWsIC3SEs4M42p3fpvwrT23Sl123a5Niy3bBitdi0SXGLWxstaenOEU24epivckOaoQgtJGQNnO2YKANUjpNty3VeyyMouYIHwXQV5DO6CKAoBrPUpXUgZkgCn5lVE8c4mYEXaxuiPV5wZTVzGQsiBYwF6uiEkKK8KEwANDCkFDlEAVuEMyXiR0Yvm5aFb0WgcsOgKISJndK/yGMPUzTmUal8HCPLvVKeYS+uBNFQlIGe/wYnZC/zxOBh2FmQC1O7/3RgiZecfMZL7O6Ior9fd0IK8HftAnaxdZX8iIA6e0IOO4Vdl+vOm5T61kvOHgJH1NLk90V94F9a+0QCWQZw+nbVu84PdL0PGt1DXTo+0JNkPKH6HKhl6F3OGEhPG7Occ/qwTPXJyydFXrrzScjS4JG0pWAjJydb0T7yN1F1vGxRFpKtB42EWweK0cAByIJCjDjFyzJBPXqTaewdWDBbTHY6C523HjCH5s7axsbVjYUN9a2LTtawJFx+n6gP1G0xhqYUS2aARSpGW0kP26oGPZLQF6cDcQIOquGvWU7tF2XrBAh6+PblsUg1SDDxdga4KOf9cmIFCzsJAJnnUvpdDxiMBnaNmzxbNTOkpH+JSplIZsOtzc6RWeetE1O2zsDPdnirSDsF3kzbVptgxIMjQgWBNW4ByGBJLemd2s6K0kHwShtO5U0EWhA/eL7Oyg45eEc6Dmhk5w28rIPu0smjmhHiO0d4Hk+TZcjt+qBth1Og0rmpQh/1Rke4UcIBm3UDVml4EhyhZS8tDLdwoUPhu+lss/RN+p/DP7yaGaH+jQmP9Y3sY8Ig4HRzQ3Ap93DgIkFw027vFwbKnJk+l830zNc8tMqsdJJM+7DWvhtwk9mF0hrbZj70BBBtODwIZX8uH5QNK1QkaNkhjsdn7IksjQcGC9HCEB7S6uTQGLhwwouoeC7M/atbHg7I9U1/JHnnxQEmorRXs7+vg9L+dIpcyuNRHMS0U9yspFQV/11qddmfPbX+/gMR9uKgtXtD1B/t/qgcTAEZTWGS43mB0wWF4KYe5DTDUvAcWimKQEknJ5jcM73OgGtpob9a5m0dhiQq300Xt9NBZ7jh3/oax9b/XWrnXF8TcC7INT+2j+lhWVVrkO8nEwxpiwQWvNwZVJ88jj4XsbzHreMYslwnY4T1QiyR1EacdDYkc9VhEfRqRvX3xXtshM5DvDBaKKuQBy64/DqhvrXvGA9ps65VhL0Y4pE14a4oO0EAqAmAO4wBHcsIMEb4sl4aAudaRGawgqdYineaL2rOpg264oa6tCY9BzWI7TnXtXm5WqW0dCimcFhdOgtxOJ4FL1A+xMlcfT2gevMsESzKC9WFUGPpj3WxnP16M4A3d+cDzO+/JM2Lhs1t0aUJHCOVSU2uMGR6ETijp8/YgKe+YuOLYKu2P+ZnZQnfxKWob9288bv922uScNB9avOv0WJNOuDDoKhv+R8eZFcJC1PkJ7kGly0J3QfB6tKgoH3SezLS3wRodtdC6RMc98JaUk1hinZ32q4GhyE/La2KkCnRAYZKXOVr6HqHE+hS1HZd9EldwsjB4I3jxIdgZC880q5SQ9g+W1yYV3omB8QzSGUotYHPT1jAtoS60pcuU1yWR+M6SjpHjQoF/RQDFevuGpw4liNMeE00peGDkax94gsltIQ2NdWxMgz/Rf+jRj/J3TBIbjoYSXuiOvcv8ogrW/F7pOmPJHodiCiBrWFzzsYAMGIVNL5BogMGgQCL4l7+xsMusoaTiwCs0ThTIboArBUN1YAUXSKJTvqZLAYxzEmxDmNC3TvYArEDxWohKeLZT8+AoPjhWoXD9dBWzQzyIlRoSmiKtAuReET8o9jVqpnP4B5n8Y5co4716NHJAK6WDUEvSK0qf2JssXLu9p2E1oDGVFvx5zbOxFf9pYEp4rOp8wufCruY6cBjoLMNmyuQTWvVq+oDJ1rSqvwPqapzMVd2BHiB7/2Uh1hDHMb+4mum1Zx4x48CqCAyrSaXebdOQZ/3vZp+oXiw+eFlEqLPleZbjT/y6Sx5yXcFrspS+bf54n825oY/8rMTButQ1oZreSxx4CrmZHDiJ1cZ03c+cHj5PeKQBY7f3KUuHQBUEppAaMBpkCThJIZWCuqJn2hOWg0TjF+7CZcW8CTg7TUguPzsOhIypDqCBJQcorcYy9EIVz/YfO+lsuvEMwc856YDzsQlJuWUVfEHCQYMI8cBAFKNri5k/JFclUYxto7kQ0R7RD2qcXE9dIkGld/eRzWKSbousmBhy0aA9BtYCqtvqXjKqQUo03axQDQ8/vY0w2r7E6Lq3f3AOVmVUmBrxYYI1dD4+TvwVMW/seoc/g2AkGFIoBFzZLKxRvViu1aWsnlcVmNzuqHMRhfwa1c55+QEjF/seU6Tdv0PMmiAc9XMOpjwKvQVWXSIDV6odAwZTRyU27gABWg/RwUne45DySPwmubtUPBELm5eyyzCOvm7zmth6tT0MJLQMpb3h3KodTcciG6KMDNb9CnmCmmkHMxOzsJNuWnF5iV/CJhmvrJNojdq3VB/WVVduARvxNDpsSOzhy4d/heHKH9eQzK5GHP6ySpGThJyK2rkuFO8ip76LZOGHK1PAEfQAebu+lBLbAE/IDGxTliJRwwLc5OTD6+tNeG8iOAEqw8iDBiOE9ps++SqMoNWKgsFnALC1MMTGCiBWbHTZoJ95nn74LjFrQc2iMwo3TyTKgJ7WiLJ0vu4l1AbgsbPzouFGnrczj4j3YGXEaQaaUqQBOxwkJWkqVFIXdzZqDdqBVRLk+SCmyiLPvKF7pRU+eyMXM6ExdqO6khkw1VSAX0GdtDRl3lJetggjiakCPprV/cfO0rYxzn8a3DtaVcWw9D+Mnn4mmOUuGchENhNeUISOAi0I9DMH6s9qD54fJ5cSoypbCGeckmxSC56BHSGhOqn1KHSjzMedYld9xImKqpfZhqxZOJTscTwDDsgDd/tq/axXuS3wD5hN6M/baCO0l1OUMYNpU+g5zY+xtvndmSnyAadF1O1oLr9pOfM2DpogZLRaIScEDBZswET2DCCU85Ouy0z4yXhzfoSRRe5AQw9b2sKBsdo+hvBRpDcXvdAqCTV1aZNJnlzR49Jzs5aaggTlBWwjlixy5h4MpZze7BQcyaQ4rDpmsDTyeswGpLuHP4YKcGaVJpz7LCl+YLGJIKDdVh9oA5maamyQHHCsnXNVXmkf/rv8XAO0pLcf2w3iau0DN8gD8YS72IpOBcw2pc9eja96Gca32ytJXBSrCcs0GYVvuuVYDI4P37LH/kdozhvPVmVWCBy7pDIUacGYULCE6oa8sUFYXN1/nTNvlXXoXVkhGhwJ+alhujR3UvTii87DiUDnxhok4W7eHBPj2XaErtznYixXTrx0J/xTO7q9OVclEEEFTLV+0oDbZJMk1Fu0DpChrnz2YB+OOcQLZ7H2/rPazFtszvfNqT39sXJ4HLqC8/xQQeDxh260Ygkq0GGrscGxY9UulT3/9q/Ckbzvc2//BZ668Qwje2r6tOZFmrp26l+5WFd1bmLY0UD9fA0xaBkr8esUeKSL0lZfAMLd+hLP5sm6JbterVjNR19oAUBNzdjfuDXfuAQ3ZjDEiEw19EYvJ47+77vTHddB8eNkEMNJQxi3USYMiZXk6Xw06FSQT3tiUa6oW4/g79TSIG5MtXCMSsrGY3vy5xaQG35BgBeoNkZYaHZvt8jBIUItHb4piaQF0n/eTTRfQmskQWMqGEDVrpoAFekGjU8vO0E49R05RknAfaWk6bUiSUtucCMNZqSEbTdeMzBY+d7ZuNcIOx4hTYA+1XJ8VjiBd2Zard2xU3hZZu3NEgC3OXCOtKkPgmkTDnk5QTDewj6lSecgC4N35GTKvboAyTlHgenvgLuhTZyFHjxDkipRxaIlzM66MR4wS1dcwvVzAlOHAsOZIhwJgD2no+36AftKgyckDyAntPnfTokC3Hs502E5MRuetay791ZSLXkDRcBPBi853SNnynndbqNkszUCftFiRNOOpoITrEiCjiZCoMOcPI4k5NpHHOCMC2nuG2mTNfphTA0mwqIhM9v6WKOKU6TCgbwzlF/Nframt/qx0AUnCC2+aO+SKuoYsIAKVjBz0F4Vo+Jn67Jj8C7qF3o8XxKkY20NaVw6aDopicbRCQvi1/sKY1A3V5mytYlYqJa34G1YLvgnoBRn1BMuEaZozPAEzPZjHl56wGteM0JoV/DmFvYv5K721PmUHIDBQ/2STyJiZ9OXCLmnkzUf9RMGaukqH6C3ay4BGeCCNUCZdfoWxlHteWuklufayN5gh4IegMLuVVFCQhyZ5NiKDDZD+sA2MYEUMEw7/fOwbYoCgBNfxoMbBvqkW8HEpg6QTOWL+AGoWU7biEXeIumnApkPXSmRAGaFKfwrYfK6y5XkpeO+LC6nnrglhQxZlwpUeCLw1X3+WkvNiB1m/4OuAbg3QJfjyVFM2oMdEm+SQYtH7WRnS0QolBL0QGpBGaTgTg4owl9optTRNK2azs2t3InODP2rPGE8k+GwfeVlzk7hsinpc5bWpQYD+JiTUBEMhtqtO5ugg+kXCKU1ENDKx7cSIxV5V3uPblvoFXaBh97dwUKurt6PHZsspml4ACuReZU2I++EXuwfWzGU+NnlMZirIhpwLgNnZ3NJlxm93bJ76rO4mOhZHP47FN/Pv3QB1ovSjNwq3dplS2ddUyxwai64g0b1zzNsvlU5GzL/B0/ueYckexz2GqIzD6lFKlapRHwOz2TeD8NSMJdt9ph0nb3EUxAYtn6EBIaerUtSyGyLYnbNiW8G9tWt+85RtEJbkUMAKO5Qz/ydKWSfD8UHvp1RtnSHmRS+Dhui21onZxgylOgtpEOU+zVgkk9/Np1Z1DpV9VTwbqoNW/VUzgTNi5JbjP1dXq2TOkk1o84ZND9Ww1sttn2OvvuXXPS3RK8q678O8xch+V7V/C48yQ7EwcH22I3u40EQHJiE3if3o1RvQlA8LUiAOk41ooFa8CCF2dFP/a1iLvoGTWvHrXJ4oige1Egl/de+4GMzr7Y26+ufQ2MSWuDMH3k7NghWr1T2/iVSA60v1POS3kfnl9C5CO+Vg39dqNuVQfmOOM0VydrMZ4Lz/3MlkOUfOCig5YjtJckQI9JW5g9pWWjl5pF6IXrfjaqN0EP1xPh/JH1B0tNmjNZ2wu0xkdvJbVy0aukRCo3/f7XaUQ9XO0wu5bccHR2vhdN+lDZMeEWKQiHi6mLY62/lLczIYAuhVQfkvi7hj9Yx9xU2uzWSq53JH8hItQt8mIjlNDs0bKh74QcNnBQHTS+ehMEcroYGRvAIjhC5Nq4WBr99nthTe1r2P5WLGiW7CUlOkbGbroGTt4RvzlT1naGqEsIa5vwkmwh5iNGPlT+TeSQGxEa0+3sHrm6ijJrXemufAoMXntiWgTqhc7GLnIZj/YRvgsxsPevFFcOtIlcg9OjPBXbn/Olsbv3PpGPvRT83ZbMnrC7d1fcHoeTOdNnphOx0+/0/Gz1UJaCR4sh2y0OxVl6uXI1LbWxBFmZtdYxf5rqEfc4oS5qPISc1r7kgpqgzZxnRFIC4jeqmZxLvDbRYvudEDEnG3XFe8L6GQ4POLOAXy8tA2YlOBoft8qGKlP67jiPuKSn5PEccu7tibNAOEhw6CPlak+ZDLrj8Cj/wgqVeiqHx4LySU5fKZ7KVV0Q1idSvFGVXXCkRR97/kS0acXdkuD93ZR1MlCWIq6nm5Pu1lSPfJc8xON8/V1d6lxapwd+igSSgXPA1HiWmr0qtuShRS6mmLBRTXhPC0pHh7xMP3RaokNFKYEBIYECvP2clle2MMb/YI0CKxZa6PLB07IU1jNzs/+uUMIoCa/4JIx+UskhRIsUz05fxYIQ4NNjVt8Gf7cGd+0TP6fo8QSuho0QphJY9eIdMj26DHzLB44rCpHJpuy6ZNtCmXwxLUd3ldWba23s0ctPX6NNMc/VXXtaaKNHT2ZZ9eLNy6grkSuk/yV2bgOc0tIsDynIDALyzM2T/DNadMj17pxpQl2KdChEaFSug0b/Z06UB8mkSscvEbIl0pXFjcI2+iy1FKtmzoZtzEmzEFiiwvjdDJUWXPJSov5iH4Ye91xxS/zciMid+GEQnKbyjn6blc4+T9BtcqGDbex31ZVTJdqOy9IYToL/RGInhrtN2VwYlvKfiXdY6Yk7nXEZb7VL4KEcO71MJiqqM93NcdfJEQRqtSOaR79TRkRyxcTfdfEeHuELbtTrrryU568IjbfNgjmHBpxJJIoEUEKRXw+Yv37BNfmo67UT6/QzdZqt3h15UDX74cIyn3Y14bFXO8UfxAnzuWIo1GOXiD7wmpIsg+m0Hhe1bPrguyac7PBO9juPFNOTJHMSqiNgc9KtzSRvvlU+5M3me0d41S8Flfk0Pp7jbkTAdnr+lzVkTrTsY4qr/9HoEetGBtELQ1Sfw3Kc2+JqLtmSom3Q+wf6gRigG8tHThyb7k8DnSJ50Db1YbXMMsdFYJFPrSBbI+aQ4xsNTsvQ5dd2qek6Ec/1rOieg1jjqOTuy7CC+kFOK8TOmA4spbTsG9Nka7wIwYDdzL0e6eYWAB1LixDy/eTmO+msBWrQs//OK9+IBcTOgjltrRlqrQjQWCztrnoaSjqiPv9pCoGpzjpCLq0YVUSSejyp4XK2LdMZG9hA5UcrmEAWt9Uk7tNlo5RgxLGo2R+vHaji2DfcwybrsUIAsKxjf+uUrroWEPuwsnKz0AhqVFbrhwFI0YB2pEvOeFFuoIBa2jyCMxCgwDgBKRGtWyhkLSWzH/yozCeHecT2Hv0pyvVV7E1VbP51yVdH8ylZbINcADpAb4N1PRkzvwBHRw5Rn59JKSdXpM2KEiu6JhNDFxf5/D507tzxUlzkQuNzX3tuqH/D0VkqufmHzr4MNYeAXveyD5eZN/4zwQE4uO5L/5bx7fL2nLV3buvt5PIMqNJ+VCwu4f/S5Q7qiFB43jFzp/pvQQt2+mfaM8khHNuU1mRRs+HOsKsDcQl1mnjg5mxRdgiAFQz+Wls9g5d5GLRVMZO3PjWJHpiCJNQMh8NAUSzBObgiS4tcIH3lsgO/c7rDqQelqjKmv3JRDuWW9VrhsMMp6gh9f5xowCt9VU1uzsBMG9m1qoemu9G1Q2DE9urWNuh8UYDLKQf6hf3i0fhOEQnLJlA7blX1xvpyZ/noUlBr8vl3R93meW5qPF4KTZH5/vPyiuD7UTSXavIWKI+6vEVTyexXK9iz2ix+zM1OwpgZIg/079zwGir5lsTe2N7IdSUrzVdZVJuIwAMoxid9b1bJN3/qe558E+MW+Fr/1q1b9Xy+kR/xhm+T7HT/g25ePW0YFXefP1fl3ac4/w0a0y1qac+edcgHUCeGIC3R1Mu4XU+tWcn2MinR76ymuJCXuUQipgPImV50tw/AYBd+2Og1QQouA4Aec3wdBgMoJYBX4AimmERKMOAjhiwIjuaO6rROfvfFACiwrHHc0a+mCzOZhNJVBpEc7e4SKVkBVK0KWud1DH0x9JgDwfN2skQVNKaAXC1/75d/KO/nAVqlQ2wctLEEc2qu49w3Be0aq6rai0VORoJS+vXxxKIJWSKYfVNx4zog1b3BvM4fxA5uerm7xqovfzmXCMaMqu97h/L9xoqO+2JaCiNDQdpQQN0TXXBHAMIxYMxyxBageGwJpyWC/LcufjCvpA/XSy1vXqCWBP6AVFORrOtYk8uftSmXZZ/NLceV6SUeuXAAa6FRspKkrZUaMAUsest9r9wv1A/S90w6k9X7VVrz3P2QmFbNqzyOGBOEQW7MfFpVR0rq4T01bw2ZHQ0bw3QIgDOH3GKDtug7lNIVm2mWzL47Byyja+hnF7YE2JHo77fF9b0DGqcR5Stt8wqgmgz27NLokM5fFBxAOvdoi+5nejBlkUVQQJHxOmrnwvE5Owmmrv2kb8GbCShSH5vRCIJlZUsTiVMr2ore+o+mwkUkFu4DUQfFfDF3lbboI/aHsJ55MUBwSskUIM6JnZp7vMXN4B/0fpNkWWvgpr2N/PZ44gm1+iawcAQAj+TEO8TJhIepbGi1yBlYeEfG+uxfT3beENFDFV/WXyIl6VtewUXtrSsh0ClDC/QieUpeNeimXY6G2crcbgG55w+feDpnD+U9Wb3fzHWb4lF+IoK3++o1Ocy7HAM0P+GeD2J/36KvEX3ksTyOW8c1YyYGTT2sivpqUc4diLR/hdlrFRbKVvpsaSl/7/1ZadZAWW6qqcGTcoDZmhoWe+YyOPRj78WdRNTs3Wq+4qjLrmL0TOMEjK6JWG7cxNixwf6dCflagvdVSGQ2n+TWlzsabI4NS+SIFfRoha5YbyXfN0NCYRXKNpO8D+b3qNhMVwbfFbdVaBh+QKHIFsV5i12afP6HGvEQBcBwjELPxQeQ1CvBxzlvWRNsWMUB4NamAd4anXHcKHJiTTrXwUbajUPGdpwZE3ds7NITUsjRveQ5rpqqUJfvdsm5ifQoxJx7EARGtAb3fmHoI3TCAqQGa8rHiMCGSqGaKsAz56iB7Tx9CaChtHoPJgSnzlhuTGlMRKzPPO8b8rS3SyVxPmD6TeBEoT721WaVS5GTx9xt1A1DnG5cF7ENrbpp7blOda2E+zhkrLmYy11fKA+1vS8i9lF69JHLMrzQ1u1hMSA73p5fcr6RWEFsKokPHGn184wWsjna46bb4Qz8VTAu67ZObs5ooV5Uq6yEQlK1LaJhzUlnLP4sLpbboaZJZ7cOAmsf6RS0MqQH3FyrBI9+kfv5CSLikAxN7xRAiv3cERH5dShobKG6EPxSx8wYUPo2u/SAKqDA0+PwEecB6i5HsJjUaVwG5Ol2IDpyfcnyXfcNVkArjI1LlMtuJOrk6Xt2eMktfFTm3YJEaUfQ4/OCM+Bivz5TJ+azndV0JXKIgDm7EiVZzNT+vZOmoal49hgwITUYIdvraMVgU7bbB/ogjNFTdYkLQmfYCaVcvKa3DnY11eRjH3QlstGGdzjRECA72nQ4NbT2W1guS192L4www08fp0xjOT8RcVp1W3d46LEP5ia1UB3xELl+VK/T4DBQdUtgRBEMBCMwTLMYgbIf77QbJuZuc7uRVaiKMo9NZeFKLW77YEItPmpu8OXHieENUIPaoV5JLs/AGhStGHVcAwGwBAQztqy74oafPmLfFg/KCQJygwCVgQAgtyj8+iSIjXKgza3VBEUzGNMDgGT2jyOY+BRgv/5gasito15UgWnSLM6zfby+yQeZoaS2C8AqdkpqhprPKzbcNICaVllcWD+US88LtiCdfr1VJ7Mf3K7bGZ3qRde5Mu+nHsh8WHjWIU1QuGYobVeiwfGbBFeQy+arFWdfSeuU05ruGXqe8YXsVsvxhSnqbLOavTbJ7CIjC4mcXpDT1EZ211L9b9YtESQ1jZDbNrbgWQGL2Xc60L1LriuJJucbamm3Z8xgXmPIOCGllEpiffZ7PPndz8GamdiBhHUmec04fyynyAKsbcLb7sdFzV5bzMKgkkVbIohwyuu4ybrsVhy1+ZhI0+TlRWClCqBSeSfYX23pDJ2u/AAaGmjAP+ZfeQ+sGg0SE+DYqBMTWCuBBdhslMv70ShWFb5ELmx+Fw4xB8Q8nPsL8BVPsdUwMg1MM6b2SQ+UvgTJW5/qwZaf3iqXuuyuxKIXtkkCRVHpAkIWhHU67mdp7ERrjk0VUJg2VzkgZ2AJQxAeXUZX/p0b99TrbUBqssOos33MDCzbVJd72eZajhSrFm6Oe2IhrSdkAW4MUb1Zjc5uCVoNICC1HzTPOfZLPj+DxphjcT0u+Tr0CbJRd0vaXaupAw2VBOwXUUZfLm9XKDlszkumPifNF9G0BKD48zNkNoLJ5WcqiqYEvc1EpMVrbxamLbBB3Q1Q/VFTr7jsfrH3wz/4YJ5roa4czaU6095p6YDu2+wgS27ezWhbFimTPMVRpG3khjWv8eiyyEzU1WiaoRk1VNMW9BeP7gWbSXqv7WnBGHaGweawRtirLEK5jXrZsLPUOF5pvPryyCsrYMJC8rv/IZDFbW+kNGcrQ75pt1GZdRrjPyBS391UJW1NkPE8zCaKXak+/9klGTl64XZcTne6EVlZ7zMgmBeAi1MiabJ1kMoxPxvN13FafcZ5tVvyZ/zpKz2jp7flWNe3vnaqSwYZYo81GRfo89rqco0x4b8R000LtGZOQz7njb9yIt/1fcmd6Yy4Pa5V9aHx5Iwt2Yty6H9G3KaRtMcLpFSNTjhwpa+kWxcyzZKbM7AGAGa2jLrFJODYQfcHG06jSTorFBA1u9I5nOLVSwsrT8MZsi6HTSB4xloWzu410HOP2ARAuK++Xxji4KzHj0yvYxp42AAMVAqpc7LHipcORQdTMfBCA70+Bt8FfenSuHqtd0tfLkQ49T752EzaH2z6poWYcOI3BQ2fNsr8iFUDePNlJxzBKY7y+VHocHyr4WBKDZ7gph24WXjDTkZk1qG4XzdHH4ZpbGMT48KVCcpiDwXJHcapNv/P6ElIXXHpTUGXtgGHmTUXsjEbAtsJNj8xuO5+h2wi3nvyp69lN13JlrnXrkqpnchYdyXt8uthzKrq8t2e2i5BBFSj6sccIrr2SAzA9iihDripZ3Pz7qE2ma9wug+UuTNNnmpLnqr1PDSOFhnOoCVvLnKCHbyh4YoDs/lqJ3+Oy+bDYu+Hn5EtyT9BOLwfkP/SlTGVIKXaiP0QycLiVbZxGWGfDg6KlkpJdo/NDNudJ8tG2sAmcFiuopeXAxqP1lsoIml+6E0QFcEmNth0I3gYg4hQTe3wtsz5qdRJ6zpcutJZ34WhwUyP8wnAH1PwPdZP5fvqCQIq/tAvnL7Hq7fy895yjCr+GfdqXyf/vUHjjUQ4Trde58mOAQwUZZNWw43VCmT2Fy7uqFf+2xpbUJRVWq6T0sMIiNPJ57/cGE0jYwNq4zwEUfxxG0dLaiB2MYwJfcNWjrzYezW0l5UHyWxHx2beO2NWytKk3sXkxWjJYXLxLZ1iaEaY/YKojYGI/uqjYT7UPUppzvoNko/NWDTwgW2XXauQukk6/HBXXQZUAPsla1kFDuUlKZPFNHM/v24IJxqetb3gdGYG2SzAwVKNaDaZHjVD1ehuJ81scnygwixByE/cuU6d7H24i+Dymrz1O6lc/lbGRetI92vDH1NijdwLY+4/Gy6o6h4PY0DTxhZh/A1MhxnL6BShegyjavuUgCngwTJQRVCLgcCtyYmljn85igI7K1Q20B77RRawppgIJ/UAQ12RdveunafS4eCNLx6FLWeevQJqTwguqBqy5PJMwCPpL2HxpVbC1jiKKuoHjFq5l58QEBxiWsdlYJPN2AcMDQpfzb42hyU7CjSJ37mlIIQG91Ny/wQSQ2FrwZjZFLSTET21ukWxNAUC1GsVfOqb86rL7nuc5TAjFuj7iqnDJimI8xGttituKKIfbr8KYmvdatUk14PDHN1tq4Rn/11QCUd0SiVOATVl7d2eYEOVpHQtbB8vSo2pw4sMSviqI3LhX4Yv5TqWaTqUcGNw67PX2BeeA9QVAlLHxjtuR1oUerFYkeDYmM/MJghgTtNAG31JRAFRgvzFQJsiQadIVHF9p3IDbhn0LzTscX6PPCWzfzyF8crNMGu40+HUGK06vaIvG9zrSOrBNG+M1DB8rRP1qXVCnYNtwlTOEpOZQzJLLh6qTMMxeJHhI9jagbsH5DaGG8YQbGoMbna0XzyzNEuad1YcrbJL2RSZuOob7mfIzAvfzwMnrb82eb8wz/pDY0H1z89Ec7RWPvIoyUSCs2KD7BnagQK7JA2WOlfq+IJiP5a9dV17xt35kdWu1uld8hQCykcmQNBlHQtdlMW2Br4jSR9oc27qA3eGdKHSpvnsAKz4xHyx3QrvyM4nr1evzU+Zr7+EoAe6t36tOJXMvnuRmMwGfXuH9WT+fhUnPxbjx8c8Kxk5AIyKTY54ZUrH2loaC02YMFU9RkzkWVVKxULAhtEzIHtc6/qYLM6Ht09paXMsifwyYqQ41YnU5SRzBhsHTi4yPYtGFkTteRHoFx/6hXuGo6Gyk9JeBpRaP4u096qaLJ7ufw2fNoyKDEDYGe6AekUb+JTlYiZe5hG2jaY6d1Wm5dzepz756eTbXyOnaU4Xh8X1C28gdKSGf4ras5/qyzIiK42q7t0gyj52frrUsjrLDbhO1sXmKIp4F2ev5T6PzqssYbLPZiWrQicQ+qwyBVMVzSWHUkloNKDJ1m6pxyZOk7iE7cDRE/Eoqe+vR33+nZQV+DgoimtZH0oGBlwTvRGdpYxbzJaF3Yk7tWLy1ndmUlca7XKiaDZkIo+U4Hrs6oMtk5wfwrxYhTo1aFD1XVY/tvfbrPUbTm3gBqYS56vVNxFPO9gJwsb9atkM/4zruOH8FI3pNtMrs71S7NZGgiEPUrfnyIvc8j53vo2b7lLduGWTm3/YrqaWoNCtcETcoBuZpCDQgGU7kYuBV6LCaSkZ89jwK2xEAPQ7aNd87GT22rZm9yxRrBIaLkosNtzr6oBDDontlxtx1ni4K9ceOhO9teHasOd86ueycTq+sbtYFBI3M7XQadTrkjVojOJTKwxGCTjln6p9zXvYfLn6b/baXPKbZ9uzavaDa+FxYk16/lBNbTMqdKVmVFrA+qTJpwc5lfnqStMBjjxAyS5BWeJ0qKUzoJcJdGfvjt83PGZKF6WQmnTtRpqmgmTyfX9sdb2YFW1ttYnHx7sNb54r7rEUM3SF3rD+Y2/QK0qpzxoDRLqdzioNOqENGL6hVHEIa/bllqOuoBXK7hFu5xkPPJ7jFI4X2oVGnq7tBRhSAA7HqdW+8BGXq8NOSQ+PSl/ypJZXLHliRymxM9bcSgyUVzOD/YQwZcxMfTh8PQOmINHj2rze0uRjd93Y88UBQXkAO03AZIJnvNdo0D+a/9Dc+DQ5oJE35Ci5uo1L5nqS4cN1ocixxCQ1+9omf3KJ1nSyhwX7iJeYOiklgSPiResQhiDsP8dO2pu3PbtzkYqGa/2dg/o7t5cAqBvbXkFcZ6wGwMrH6SUW2YKUov5fyaMnLCacMhUgfnOdE7CS75vR8C28HKYyZ/e+uLFAEbM/++7RnKl72BgIalz0N+eppt0xKGBFu32ADQ4h3PBbrLfEUSLLe3za0CmSL9368VT56yUZMW8ZLg97l6oNi/79Gq2i7MeK00Z2RY3WZuBZL4Hy2VFCitFKMq/7HXeK2F9zV+NPvdjqG/K6N6diXwlPnScv2YaNEKnPbUTvs+xOqJ4OmstH4QkgPXp8Tdo8cccDzhgB+hhvsWHe6bXXF/TxhvI//WPdIf8zsyuulZagv8VickU6Kzpzml5jdfLxe3bedKALXknPpKeNxzGsiNdnp5HHeja9nnRETi+qwRpj5JFIAnadmpHjVBvOxKJQJH+tNoIcg+OtrzXAwOysBu4NvUrHFe+xySAAAOcngkR6Q6bu61GyfgHgrTGprT0AGMV8pzO3sTby6ARfZiZBN/OZLW738/W+dVI1zuTYu6ibOLjPULx0v3oF9PD8PeejmsBQ8xkAw7udRWRoigg7VZeoz+NSL/JpQqdLiS4919JVHet8BnKoWzIhseW4zHp+ZwDGDzQVXdDJdT/2OUT7fCXRqmXsMUwIiJ3ugpP2JhC1MdbtrDVbwaHMiOpDRgYtFZ+i8spAoiyVqG8sqCUMDmL4+d0YDwZ8f4Vei1KlKFoIbFCek3nX7AFgrLsp8DB7moPjazmvyToG5vKSej9ehwHkKQ7CTrDFfLGutXZUNVXV5HffEzAPtmrxQPxfVi1vdufv2fzKlXyrnorXtVauDF8CNoGqHEqw8et4ST9lz9iuHtl2t4EDwhbPKDPJMzHVmJKylwPZBFon5pmjwvrSwz2BgXDOBTOO9HKTPPG23x5ZXhpzY8vP7Vb/L2jBnVeql7rg3OnfT9t0Kh2nyTO/2X9mIE1fjvS5xwu38PkfjvlHYCE4kxlIZj/YlCYq6VnRUYxD2ciB55p8E86YMezD9Mf8f8veAAxnrH7ggoV6he/Z4cUSUtAvXVWFppgzj0GzawT9ruImrS5HiqYa4XoW8jInd5U5WunagNH3KE0UI86R4nUfj5QUoBctQdJL8rv32YAuujxmZqjV9Er801582do8t0+kJkpNihTE57kG9gtl/j2HbctQtPPIlqIkdRTbW8KsJh5QgEmJsG+E9HW5Twq3hBi3TBoyVa5JoTRLNfvVTQmhHzUAGTY00fCrBr9mujR2L1RFWkHKL2V/XmsldUYJU364eBDFpQz8cShwfbDjKx10i/nzctUfzB3VaMSks37ZD9w4PncNOHR5VgYaMss+aLWYDNr5vKaVNKXySFcGrr16SyMaU+tKYiAVVHubD/Oo8XmZ4FptQJXIQEPxJiU3f6iKLajZ5RUZxkf3xP2rb1rkwln6yrDTo8HzwOYQjeg8lB065saSplpmSlr/vcGCLjxGsatIOtKWYlKTGfhADTkMJtzU1REAPS205IBSiiBRuDEDNfXA18d8CJQtwUYtZOaozyLziARzhnySR+1iVm62nZksxxED05sZv+5XvEBYQRuJCMg5NjlIesm0sepM/X5/42xkLDLBpJQqYHOtXdKad6cIcBNIIy7edchQnE72SDB1xWnaG6SLshhilIlMvT2gAitQD+gC1jQsNWjtiTUNVDVTQu+IQ2lF7ISh6zcUvMDYihSxnBpP/vTHcUYVkpbo6TmMuSOajy7Ue4lxG1wmjOancguBrjjn29ttsj1jzZPh4DTSlOzsfeC15y6WoytyF3d86ju+9i9m43r8BdscJfvHLowxRVmABn9D0Rds9w/8wS04L4WlL+sgWgSPZmLfXTO7+X8LngXP3mvTljfG7auzs6rkYzO3t3mRfFu5B+iQy60NWwfc75pTKkvVkWS4Y2cmnIyizfEeA7D44Yhe1kgPDkaZAIuILueXyQIKgdhHdjXYalyzITNvSirJEJMMjZmBzMCD5FFolDm9xOh41IVpGDqsTwA2V/dyB2tsOReFqhEvkB7LEjmj5cgNkColf/oULz/a8ai6Ab4Cnud1n3pptP7Vu5qmjijDp8IZs52gE1+Rq03FOraZK+NxOwDIHTsYqxHUdqBo2NCxFAiPgGcLx1rK/WxTYyU9EDA+7ltnqOna4ZAw9XZhgOlpsBFoDgipOQ1ctFEkd0jJxsyDnL1eMo6dzgSkYVIT5m5emJ2bcMHHsN0+Hjc8wi4lkeOa3+EuuWmcyC2r1ePqV4D/pIbjyfH48TjRblEuXKO71J2Usimx3pL5DOaVrhzVvuYFrZPLken7lSxO/zMalDLrFfPd2Bjzl9KwGs+cdzCArvLNSgr2we8HnDz99tLyzspIBbDxw6vU4zDLYsXzrGM3SxAVbDR70bHB+gza+9Bjz40EM+TagPitaaEY0j3ZOyNUhuZt8oj94tTtyE3r8t5plVtd8JB7OkzZZWkSXpk3rSmdu5K9yXU9VejSsHqVI3zDsXecWGFEySmBkzcHT7xJWfb0DZmqp/QpitRkpmFoJqGUT2wU2jOhXNpn2c8g3duU9a0/IFBDDr2zUEZB44e1Wm0BQuPtifBqZbFWrandXx6Ijgo9c1lwXj8H36NKqartTmgCWCx06TXHjTR9Ii7o6K6vOguUzEwg6AzHMcd2mboi3xIOdz2L6bD2paI6N141swWTWMhNeNJfmu32iC/n35U7X+e83JBDF+1Soj7kDHCKV/p2D7B9GSgnzb5mIkTFDnZDB6QjEKi4rDUXg0XrqPBvEiZGVqSly+qULPWtSNM672EUvCTdVJf2nfiPPOvlm6lmwsDZ7MHiZvCaQVCS6uHBzpD3Zc25oNchJ80ex46kyWFaL0M9cqIYWTZUVzGpi/og+Az3uw7OO6boVDFV4EwJrjmPNkdkpFzi12lczi5L1aVNqL72iLg0wSwu5pLr4W+9vrxbaXl4R5jeSi+NOm2OFpBBhjIZ0QFDBglkuDMi9MhxaMtxaG3HRrbrkEddYNpHmZYIpdm0uS1S9gvZAssSULlTCVFUg6aTShaq5G8YMxGlXG2O5xxksbm6M+zDWYcuU1ZXNHiPP2kE0RovEwT5k+SqOvbHNZAnwUPf7EWudATG4rqD72CDdwTVpfV7jnc2fm2rytdv3X73WMJjpfmNST0XKYPSbi/qag6aS4T2BV6jRz8zUrytTzUv9XrDW+q/v2Zqv3h+WI8rFoCRVYPvUN2c6yt3lZb7y+z0NLyZLej0XdLy1P/0mwpNvKOE79G54qpf3pbIzn9wbmpoBnj9WOjg+y79bz86/Rw6X8A2YUEEGyN9+DODRIMFjqccpo41ua8V/oMQLMGk7YwOY5nPWsWNmonTaEuG70bWdWLomAzG+po2Wp/8DV07C1EA0kzn0emvrPCMahSP8Tzu15KXiUf4hQYxyMg6xcobOjH1GbnQz+uMttOiDJuhWKsWvjOjzlFAe7Mav+lyS0wDRpmZcdXKCjPxACUuJVa9WlaVVbWX5lrEvyKiBC1nsNPZv4c9aSj/Gfaa6a46V7Z2i7jpsoNiAIt5Nz03lZfvxAhcUhGe8vN0q/4Z23WgwjH7oXHAZ5TshueAujh96+XG7Fekg+NYvYyNDohvRnjSULY9POgAxLw7NcEFFKU2+OgtaPDjF27s7LsSn2H3uFoLAg/sbFEUDORbSp5Mb7xDwHajxRgHCOs0PSgUFYe+QSeXAifFt9ACq+VBX5MAgTzwMXB6HZCvC6NOXUpqafcFQl7wg4uIKX3uUAO/gGlBan6g5IU8Ur6MRLATq52hq2gMgORvwsO6n4ag27DDGwOpRUEaZT8tS3fQu2+a1xJtVM6vzJJ6Wk+9IFVLHYNl1aU9HlrRMsD7utl5HzY15sVSdrsOc4V57xV+STqkGKiB2fuN7N2dGxEUi1Hp7uUJmCIKAiTYSA1Q8MCGAAO2UAeYMEejwOrXBtiY5GqAAwv8JHNjvzFgCkfCVDDrHxEwRz4xZzkLuBJ3QIFgcF3iEvEJAgQcyOYACQvybIDC/HU7wMCYYgaYcKEmyqyhf0WADVWlBjhwo67KXOp/FzDFlPoPmH3NHh8wJ0YkeMoCF2DtX6KdhXID3Vbb1lr+FndduiiWK6PBEzFem8Y59rXl2EVefMMVEsJGZ63VLk5bBVYXGfttq4+pm3Ce8LXGaqNOjtq5nycS96HSoeTdhuCQ3E4orjUkuuxOM98izQcREo+88qGZy3KeVIsV4oOD5RDzci4B6NXQwMUU4pHMUVI0ZFXLdxXxlfdEIq2J7TNEEL3nYuFRtx714v6fvcq2oO0W9+5Knv92z3GXsMxaFXoYxEJEcGDwIvRRHpSZoOXlCtPheiBHqiGJlZlRqQ25nNSZJJlLbL6aLBlYy8ZlizpUSXRNcDETEScLPYG52EHOC3JCkIuRtSQ5ddqsL9va3KWDpSMZf7q8XLwQXgbOZPIUyEI7cx6RYP4UMg/SApNP51V1PYR5I75aFvNtYMXemQVYsoD+aEw2YUhBy6E8foa1Z2cQyRZl8LXvE4l5nCiGT+ZQBqsWnUupX4MLJLQTrokUNxkUdUC8wDVdNUuTQdYK2RpZGXlzFJRg1E3GnFTwFRBMiXU4V9bmALIwnYdO6hSjz1WyVgO5AYv1MgWyqLrVylihjMgSsjaYC+u6xjc3Qk5lZgUnCduYic1FksPaPSEhEkBQyCXf7dNv8HKXpBgU44u0If4mwAH3r/P+jxsLWMIK1rCBLexgDwc4wgnOcIEr3OAOD3iCB74RGGmU0cYYi3HGm2CiSSabQkBoKi/TTDfDTLPMNsdc88y3wEIlWGxJSILCciuIePPhy4+/AIHEJKRk5BSUVgoSTGWVEKHChIswhKgwsChMRIr2jkM4TLBwBOdxDO24gIsEm+AgHUdxDdfpODrQgJd4i36oUY181KAO9cgguMhCEzJxEIX4Fb9RKX6hP+h3/Ilu3KabpEEMJBS+UrxPuIOHdA/36QG+UgK+0SM8ph4k4j+eYhBPKAm/6AdKQSxFjgwFSjUqGFh4Dg1a/MQ2DOgx2m2XU9iLPfZhP77Hj3jp+P9zgf9lQYgIMRKkyJCjQIkKNRq06NBjwIgJs6Uoq7ppu34YjSfT2ZwyLqTSxrrtbn84ns5103b9ME7z4kNMuazbfpzX/bzf5Xq7P56CpOhAKBInwQeXTK5QVmqG5fhGq9MbjJ/v74+fgCAhYSKixMRJSJKSJiNLTp6CIiVlKqrUgisJCo6o09CkpU1Hl54+A0NGxkxMmZmzsGRlzcaWnT0HDzx64tkLr95498GnL7798OsP/5MjTpMzLpMrbpM75kFHjjlxyplzLlxy5Zobt9y558EjT5558cqbdz58MjFlZs7CkpU1G1t29hwcOTlzceXmzsOTlzdfvvnxy59/PqEQEBOXkJSSlsnm5BWKSsoqqmrqGppa2jq6evoGhkbGJmSFStMZphXaHK7HD4QisUQqOylyOF1uz9z8wuKSZStenz8QDIUj0Vg8kUylM9lcvlAslSu6umZ9w6Yt20IqHYRRnKRZXpRVbazzTdv1w7hrb98BWnT0GBgxMWNhxcaOgxMXNx5efPwEBAkJExElJk5CkpQ0GVly8hQUKSlTUaWmTkOTljYdXXr6DAwZGXPqjHMXXLri2oSpGXMsWGLFGhu22HGDW+5wzwMeeYKACAkZCs944RVvvOODT3zxjR9+8cccC5ZYscaGLXbsceCIE2dcuOLGHQ+eePGGdz7wyRe++cEvf/jn7/HZEEIRYolUJleUlVrT6vQGo8lssdrsDqfL7eXt4/vIiqrphmnZjuv5QRjFSZrlC8VSuVKtGYpf8C/XPtEGMWwu9qAh19hghWg9n+09wk022Li7u3v2bOvWFJ+i4+1FqMrNhFix44t4FQCA2rCLQZ/z3sX0DBEmlHEhlTbW9eYAESaUcSGVNtb1FgARJpRxIZU21vWWABEmlHEhlTbWSRZvzgBAGEsnGNCL4eVKWIG6egtqKLnDUAsQp+MuXk5swFFiQ5mAAykZ3BXDW/Lx3/eoPwhKePcmZvMoJYAbmEvSw8K6b+aba8vfy3+6wnZXjGeIUOScAQX6VGiotqMdf/QOBCUVNQZo6arXQVi8BDRUu4Y0dp83naO8dD3YiIzSxlEOpUK6gLDITQoGsqqMYJSBuX9B+sSNKf+f/cgjw8nO0PwfPd6KjPF7wc9l9CvaiIwk7E7PvuZN1fiXb0IISSHChDIuyhEiTCjjQiptrOuNASJMKONCVldyEUIIIYR8oo11vacAEGFCGRfyny6eICBMKONCnkYb63pPASDChDIupNLGut4MIMKEMi6k0sa63hwgwoQyLqTSxrreAiDChDIupNLGut4SIIpXiDChjAuptLGutwaIMKGMC6m0sa63AYgwoYwLqbSxrrcFiDChjAuptLGutwOIMKGMC6m0se6sFoGLgDChFAJmMS+EzLshq333ns/dy4EzfbW3Rj2YpjDWpYJtT4uyHHKe6a6cI64Gmppkljqt7VuwhJPAaljOMrhMtWNUrN31LpNruuqvtdJXOizDLXZeYzbLhq5GWKI13Fdy+klTcmCseaXuFL7AE3b9SKoJfqWczxBHyLZ4q/Yqtp1Xox0TlkOYoDxCnMoz9VWkYUjFlUeXpz+Ydb6A1PFKhDEX8l7ENWcEutLDhAVBGzOOjSO4a0LdJtxO9sAL3hq5lF9RNGflCeTRSLpb+DRtDDjiD2+UWCdAL6wIlxpeufhezc0eNMHw4NQGejM6T2CMqwM1R+lCalQesxp8TXf6PN5qECRJXmOQEUjoXMptW8K7OBUxXbRIMpRK7EgL3yxIGhCkyTHUFCWrNcKMztwn+DZkhKI0gbk90Zw5c83A3FxCuioWUA1pfYJjJxYqpztwRtd1DJUqlJwpmuKN6RoS8XspwTTqXVCNXTtJkJYNkmQaJ7xykTOsw3hWr7XSFVlKDgPYBB9jShgs1d5KsvE2WEKRU5hmBuYUuKrVaulWn7syRk0j5Tg5ckqJay948hIOZao0J24ZbqpQXLC0yUySwaHGDdYDrahlVFVKCaRxhbY+SeBQ0JzwkpwsNjXbKb33zoRTaawhqfXLlX3sDvw4l4cDBeVxAQAAAA==') format('woff2');
  font-weight: 400;
  font-display: swap;
}
:root {
  color-scheme: dark;
  --bg: #17100f;
  --panel: #1f1613;
  --term: #0e0806;
  --ink-1: #f2ede8; --ink-2: #b8ada6; --ink-3: #8a7c74;
  --line-1: #3a2c26; --line-2: #523e36;
  --accent: #e0533c; --accent-hover: #ef6349; --accent-ink: #150907;
  --mark-face: #0b0b0c;
  --sans: ui-sans-serif, system-ui, -apple-system, "Segoe UI", "Hiragino Sans", sans-serif;
  --mono: ui-monospace, "SF Mono", Menlo, monospace;
  --dot: 'DotGothic16', var(--mono);
}
* { box-sizing: border-box; }
html, body { overflow-x: clip; }
body {
  margin: 0; color: var(--ink-1);
  font: 400 15px/1.6 var(--sans);
  letter-spacing: -0.006em; -webkit-font-smoothing: antialiased;
  background:
    radial-gradient(circle, rgba(224, 83, 60, 0.055) 1px, transparent 1.4px) 0 0 / 26px 26px,
    var(--bg);
}
main { max-width: 46rem; margin: 0 auto; padding: 72px 24px 96px; }
.skip { position: absolute; left: -9999px; top: 0; z-index: 1000; padding: 8px 14px; background: var(--accent); color: var(--accent-ink); text-decoration: none; }
.skip:focus { left: 0; }
.top { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
.brand { display: inline-flex; align-items: center; gap: 9px; }
.brand svg { width: 26px; height: 26px; }
.wordmark { font-family: var(--dot); font-size: 19px; font-weight: 400; }
.locale { display: inline-flex; padding: 3px; border: 2px solid var(--line-1); }
.locale button {
  appearance: none; border: 0; padding: 5px 9px; cursor: pointer;
  background: transparent; color: var(--ink-3); font: inherit; font-size: 12px;
}
.locale button[aria-pressed="true"], .locale a:hover { background: var(--panel); color: var(--ink-1); }
.locale a { padding: 5px 9px; color: var(--ink-3); font-size: 12px; text-decoration: none; }

.hero { margin-top: 76px; position: relative; }
.tako-ghost {
  position: absolute; right: -88px; top: -44px; width: 380px; height: 380px;
  opacity: 0.14; pointer-events: none; z-index: -1;
}
.eyebrow { margin: 0; color: var(--accent); font: 600 12px/1.3 var(--mono); letter-spacing: .08em; text-transform: uppercase; }
h1 { margin: 20px 0 0; font-family: var(--dot); font-weight: 400; font-size: 40px; line-height: 1.25; letter-spacing: 0; overflow-wrap: anywhere; min-width: 0; }
p.lede { margin: 16px 0 0; color: var(--ink-2); font-size: 16px; max-width: 34rem; }
.actions { display: flex; align-items: center; gap: 10px 20px; flex-wrap: wrap; margin-top: 28px; }
.cta {
  display: inline-flex; align-items: center; padding: 10px 18px;
  border: 2px solid #6e2418; background: var(--accent); color: var(--accent-ink);
  font-size: 14px; font-weight: 600; text-decoration: none;
  box-shadow: 4px 4px 0 rgba(0, 0, 0, 0.85);
  transition: transform 80ms ease, box-shadow 80ms ease, background 120ms ease;
}
.cta:hover { background: var(--accent-hover); transform: translate(1px, 1px); box-shadow: 3px 3px 0 rgba(0, 0, 0, 0.85); }
.cta:active { transform: translate(4px, 4px); box-shadow: 0 0 0 rgba(0,0,0,0); }
a.source { font: 12.5px var(--mono); color: var(--ink-3); text-decoration: none; border-bottom: 1px solid var(--line-2); padding-bottom: 1px; }
a.source:hover { color: var(--ink-1); border-color: var(--ink-3); }

section { margin-top: 68px; position: relative; }
.shead { display: flex; align-items: center; gap: 10px; margin: 0; font-family: var(--dot); font-size: 16px; font-weight: 400; letter-spacing: .02em; }
.shead::before { content: ""; flex: none; width: 11px; height: 11px; background: var(--accent); box-shadow: 3px 3px 0 rgba(0,0,0,0.85); }
.spec { margin-top: 20px; border-top: 2px solid var(--line-1); }
.spec .row { padding: 16px 0; border-bottom: 1px solid var(--line-1); }
.spec .term { display: flex; justify-content: space-between; align-items: baseline; gap: 14px; }
.spec h3 { margin: 0; font-size: 15px; font-weight: 600; }
.spec .term code { color: var(--accent); font-size: 12px; text-align: right; }
.spec p { margin: 5px 0 0; color: var(--ink-2); font-size: 13px; max-width: 33rem; }
p.get { margin: 18px 0 0; }
p.get code { font: 13px var(--mono); color: var(--ink-1); overflow-wrap: anywhere; }
p.get b { color: var(--accent); font-weight: 600; }
pre {
  margin: 12px 0 0; padding: 40px 16px 16px; border: 2px solid var(--line-1);
  background: var(--term); color: var(--ink-2); position: relative;
  font: 12.5px/1.65 var(--mono); overflow-x: auto;
  box-shadow: 6px 6px 0 rgba(0, 0, 0, 0.85);
}
pre::before {
  content: ""; position: absolute; top: 14px; left: 16px;
  width: 9px; height: 9px; background: var(--accent);
  box-shadow: 16px 0 0 var(--line-2), 32px 0 0 var(--line-2);
}
pre b { color: var(--accent); font-weight: 500; }
pre.cmd { color: var(--ink-1); }
.flow { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin-top: 18px; }
.node {
  display: inline-flex; align-items: baseline; gap: 7px; padding: 7px 11px;
  border: 2px solid var(--line-1); background: var(--panel);
  font: 12px var(--mono); white-space: nowrap;
}
.node i { font-style: normal; color: var(--ink-3); }
.node.capture { border-color: var(--accent); color: var(--accent); }
.node.capture i { color: var(--ink-3); }
.branches { display: grid; gap: 8px; }
.branch { display: flex; align-items: center; gap: 9px; }
.branch::before { content: "\\2192"; color: var(--accent); font-family: var(--mono); font-size: 12px; }
.billing p.body, .selfhost p.body { margin: 14px 0 0; color: var(--ink-2); font-size: 14px; max-width: 34rem; }
ul { margin: 18px 0 0; padding: 0; list-style: none; border-top: 2px solid var(--line-1); }
li { border-bottom: 1px solid var(--line-1); }
li a {
  display: flex; justify-content: space-between; gap: 16px; align-items: baseline;
  padding: 14px 4px; color: inherit; text-decoration: none;
}
li a::before { content: ""; flex: none; align-self: center; width: 8px; height: 8px; background: var(--line-2); margin-right: 2px; }
li a:hover { background: var(--panel); }
li a:hover::before { background: var(--accent); }
li a code { overflow-wrap: anywhere; flex: 1; }
li span { color: var(--ink-3); font-size: 13px; white-space: nowrap; }
code { font-family: var(--mono); font-size: 13px; }
footer { margin-top: 72px; color: var(--ink-3); font: 12.5px var(--mono); }
footer a { color: inherit; }
@media (max-width: 640px) {
  main { padding-top: 28px; }
  .hero { margin-top: 48px; }
  h1 { font-size: 30px; }
  section { margin-top: 52px; }
  .tako-ghost { width: 220px; height: 220px; right: -60px; top: -30px; }
  li a { flex-direction: column; align-items: flex-start; gap: 2px; }
  li a::before { display: none; }
}
</style>

</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<main id="main">
<div class="top"><span class="brand">${takoMark(26)}<span class="wordmark">takoserver</span></span><div class="locale" role="group" aria-label="Language"><button type="button" data-locale="ja">日本語</button><button type="button" data-locale="en">English</button>${noScriptLocale_}</div></div>
<section class="hero">
${takoMark(380, "tako-ghost")}
<p class="eyebrow" data-i18n="eyebrow">${copy.eyebrow}</p>
<h1 data-i18n="headline">${copy.headline}</h1>
<p class="lede" data-i18n="lede">${copy.lede}</p>
<div class="actions">${console_}<a class="source" href="https://github.com/tako0614/takoserver">github.com/tako0614/takoserver</a></div>
</section>
<section aria-label="${copy.products}">
<h2 class="shead" data-i18n="products">${copy.products}</h2>
<div class="spec">
<div class="row"><div class="term"><h3 data-i18n="formTitle">${copy.formTitle}</h3><code>Form URL</code></div><p data-i18n="formBody">${copy.formBody}</p></div>
<div class="row"><div class="term"><h3 data-i18n="holdTitle">${copy.holdTitle}</h3><code>Organization</code></div><p data-i18n="holdBody">${copy.holdBody}</p></div>
<div class="row"><div class="term"><h3 data-i18n="objectTitle">${copy.objectTitle}</h3><code>Resource / Operation</code></div><p data-i18n="objectBody">${copy.objectBody}</p></div>
<div class="row"><div class="term"><h3 data-i18n="meterTitle">${copy.meterTitle}</h3><code>Idempotency-Key</code></div><p data-i18n="meterBody">${copy.meterBody}</p></div>
</div>
</section>
<section aria-label="${copy.discovery}">
<h2 class="shead" data-i18n="discovery">${copy.discovery}</h2>
<p class="get"><code><b>GET</b> ${base}/.well-known/takoform/v2</code></p>
<pre>curl ${base}/.well-known/takoform/v2</pre>
</section>
<section class="billing" aria-label="${copy.billingTitle}">
<h2 class="shead" data-i18n="billingTitle">${copy.billingTitle}</h2>
<div class="flow">
<span class="node">wallet hold</span>
<span class="branches">
<span class="branch"><span class="node capture">capture <i data-i18n="onSuccess">${copy.onSuccess}</i></span></span>
<span class="branch"><span class="node">release <i data-i18n="onFailure">${copy.onFailure}</i></span></span>
</span>
</div>
<p class="body" data-i18n="billingBody">${copy.billingBody}</p>
</section>
<section class="selfhost" aria-label="${copy.selfhostTitle}">
<h2 class="shead" data-i18n="selfhostTitle">${copy.selfhostTitle}</h2>
<p class="body"><a href="https://github.com/tako0614/takoserver/blob/main/docs/takoform-v2.md">Host API v2 — operator setup</a></p>
<p class="body" data-i18n="selfhostBody">${copy.selfhostBody}</p>
</section>
<section aria-label="${copy.endpoints}">
<h2 class="shead" data-i18n="endpoints">${copy.endpoints}</h2>
<ul>
<li><a href="${base}/openapi.json"><code>${base}/openapi.json</code><span data-i18n="api">${copy.api}</span></a></li>
<li><a href="${base}/.well-known/takoserver"><code>${base}/.well-known/takoserver</code><span data-i18n="product">${copy.product}</span></a></li>
<li><a href="${base}/.well-known/takoform/v2"><code>${base}/.well-known/takoform/v2</code><span data-i18n="host">${copy.host}</span></a></li>
</ul>
</section>
<footer>takoserver.com &middot; <a href="https://github.com/tako0614/takoserver" data-i18n="source">${copy.source}</a></footer>
</main>
<script>
const messages=${JSON.stringify(landingMessages)};
const localizedPaths=${String(options.apiOrigin !== null)};
const pathLocale=location.pathname.split("/")[1];
const setLocale=(locale,updatePath=false)=>{const lang=locale==="ja"?"ja":"en";document.documentElement.lang=lang;document.querySelector('meta[name="description"]').content=messages[lang].description;for(const node of document.querySelectorAll("[data-i18n]")){const value=messages[lang][node.dataset.i18n];if(value)node.textContent=value}for(const button of document.querySelectorAll("[data-locale]"))button.setAttribute("aria-pressed",String(button.dataset.locale===lang));try{localStorage.setItem("takoserver.locale",lang)}catch{}if(updatePath&&localizedPaths)history.replaceState(null,"","/"+lang+"/")};
let stored=null;try{stored=localStorage.getItem("takoserver.locale")}catch{}setLocale(pathLocale==="ja"||pathLocale==="en"?pathLocale:stored??(navigator.language.toLowerCase().startsWith("ja")?"ja":"en"));for(const button of document.querySelectorAll("[data-locale]"))button.addEventListener("click",()=>setLocale(button.dataset.locale,true));
</script>
</body>
</html>
`;
}

/**
 * The 404 in the same machine room — same field and accents, a smaller
 * stage: the mark, the code, one line, the way home. Served by the
 * Pages host for paths that are not the landing page.
 */
export function notFoundHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>404 | Takoserver</title>
<meta name="robots" content="noindex">
<meta name="color-scheme" content="dark">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 34 34'%3E%3Crect width='34' height='34' fill='%23b0301f'/%3E%3C/svg%3E">
<style>
:root {
  --bg: #17100f; --panel: #1f1613; --ink-1: #f2ede8; --ink-2: #b8ada6; --ink-3: #8a7c74;
  --line-1: #3a2c26; --accent: #e0533c; --mark-face: #0b0b0c;
  --mono: ui-monospace, "SF Mono", Menlo, monospace;
}
* { box-sizing: border-box; }
body {
  margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px;
  background: var(--bg); color: var(--ink-1);
  font-family: ui-sans-serif, system-ui, "Hiragino Kaku Gothic ProN", "Yu Gothic UI", sans-serif;
}
main { max-width: 26rem; }
.mark { display: block; margin-bottom: 20px; }
.code { margin: 0; color: var(--ink-3); font: 12px/1.4 var(--mono); letter-spacing: .08em; }
h1 { margin: 6px 0 10px; font-size: 22px; font-weight: 600; }
p { margin: 0; color: var(--ink-2); font-size: 14px; line-height: 1.7; }
a { display: inline-block; margin-top: 18px; color: var(--ink-1); font: 600 13px var(--mono); text-decoration: none; }
a::before { content: "\\2192 "; color: var(--accent); }
a:hover { color: var(--accent); }
</style>
</head>
<body>
<main>
${takoMark(34, "mark")}
<p class="code">404</p>
<h1>Not found</h1>
<p>The path does not name a page on this machine.</p>
<a href="/">takoserver.com</a>
</main>
</body>
</html>
`;
}
