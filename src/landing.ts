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
  /** Canonical public site origin. Absent on API-only/self-hosted deployments. */
  readonly siteOrigin?: string | null;
}

export type LandingLocale = "en" | "ja";

interface LandingCopy {
  readonly meta: { readonly title: string; readonly description: string };
  readonly navigation: {
    readonly ariaLabel: string;
    readonly brandLabel: string;
    readonly languageLabel: string;
    readonly openConsole: string;
    readonly readApi: string;
  };
  readonly hero: {
    readonly title: string;
    readonly lede: string;
    readonly signalsLabel: string;
    readonly signals: readonly [string, string, string];
  };
  readonly map: {
    readonly legend: string;
    readonly status: string;
    readonly resourceDescription: string;
    readonly controlPlane: string;
    readonly controlAction: string;
    readonly controlItems: readonly [string, string, string];
    readonly services: string;
    readonly serviceAction: string;
    readonly serviceItems: readonly [string, string, string];
  };
  readonly lanes: {
    readonly title: string;
    readonly intro: string;
    readonly infrastructureTitle: string;
    readonly infrastructureBody: string;
    readonly standardsTitle: string;
    readonly standardsBody: string;
  };
  readonly billing: {
    readonly title: string;
    readonly intro: string;
    readonly rows: readonly (readonly [string, string])[];
  };
  readonly model: {
    readonly title: string;
    readonly intro: string;
    readonly rows: readonly (readonly [string, string])[];
  };
  readonly migration: {
    readonly title: string;
    readonly intro: string;
    readonly ariaLabel: string;
    readonly steps: readonly (readonly [string, string])[];
  };
  readonly developer: {
    readonly title: string;
    readonly intro: string;
    readonly rows: readonly (readonly [string, string])[];
  };
  readonly closing: { readonly ariaLabel: string; readonly statement: string };
  readonly footer: { readonly statement: string; readonly discovery: string };
}

const COPY: Readonly<Record<LandingLocale, LandingCopy>> = {
  en: {
    meta: {
      title: "Takoserver — portable cloud resources",
      description:
        "Portable compute, databases, storage, queues, and AI with usage-based pricing and developer-first APIs.",
    },
    navigation: {
      ariaLabel: "Primary navigation",
      brandLabel: "Takoserver home",
      languageLabel: "Language",
      openConsole: "Open Console",
      readApi: "Read API",
    },
    hero: {
      title: "Build on a cloud that stays portable.",
      lede: "Create compute, databases, storage, queues, and AI services through one developer-first control plane. Connect resources explicitly and pay for measured usage.",
      signalsLabel: "Product characteristics",
      signals: ["Usage based", "Portable resources", "Developer API"],
    },
    map: {
      legend: "resource routing",
      status: "explicit placement",
      resourceDescription: "A durable resource contract with an independent identity.",
      controlPlane: "Takoserver control plane",
      controlAction: "Place · attach · meter",
      controlItems: ["Offering catalog", "Deployment state", "Scoped grants"],
      services: "Cloud services",
      serviceAction: "Compute · data · AI",
      serviceItems: ["Databases", "Object storage", "Queues and workers"],
    },
    lanes: {
      title: "One control plane. Two clean lanes.",
      intro:
        "Infrastructure meaning belongs in Takoform. Protocols that are already standard stay ordinary data services.",
      infrastructureTitle: "Infrastructure through Takoform",
      infrastructureBody:
        "Exact Form references describe the resource. Service tiers choose region and capacity. Deployments record the running realization.",
      standardsTitle: "Standard APIs stay standard",
      standardsBody:
        "S3-compatible object access and OpenAI-compatible inference remain direct APIs with short-lived, resource-scoped authority.",
    },
    billing: {
      title: "Pay for what you use.",
      intro:
        "Takoserver pricing is expressed in stable service units. Usage is aggregated before settlement, so tiny operations stay precise instead of being rounded into oversized charges.",
      rows: [
        ["Compute", "Requests · CPU milliseconds"],
        ["Databases", "Rows read · rows written · storage capacity-time"],
        ["Object storage", "Storage capacity-time · Class A operations · Class B operations"],
        ["Queues", "64 KiB operations"],
        ["AI", "Input tokens · output tokens"],
      ],
    },
    model: {
      title: "Infrastructure that stays portable.",
      intro:
        "Takoserver keeps meaning, service tier, realization, connection, and movement separate so one concern can change without rewriting the rest.",
      rows: [
        ["Form", "What the resource means."],
        [
          "Offering",
          "A selectable service tier with a region, price plan, isolation, and portability contract.",
        ],
        ["Deployment", "One running realization of the logical resource."],
        [
          "Attachment",
          "A scoped connection between independent resources without embedding credentials in outputs.",
        ],
        [
          "Migration",
          "An explicit cutover between source and candidate Deployments, with a retained rollback window.",
        ],
      ],
    },
    migration: {
      title: "Change placement, not identity.",
      intro:
        "Moving between service tiers is a lifecycle, not an opaque update. Attachments follow the active Deployment after verification.",
      ariaLabel: "Deployment migration states",
      steps: [
        ["Active", "The current realization keeps serving."],
        ["Candidate", "Provision, transfer, and verify independently."],
        ["Retained", "Cut over, re-resolve Attachments, preserve rollback."],
      ],
    },
    developer: {
      title: "Start from the contract.",
      intro:
        "The product describes itself over stable discovery and OpenAPI surfaces. No dashboard archaeology required.",
      rows: [
        ["HTTP API description", "Open schema"],
        ["Takoserver discovery", "Read discovery"],
        ["Takoform Host discovery", "Read host contract"],
      ],
    },
    closing: {
      ariaLabel: "Closing statement",
      statement: "Keep the resource. Change where it runs.",
    },
    footer: { statement: "Takoserver · developer cloud", discovery: "Discovery" },
  },
  ja: {
    meta: {
      title: "Takoserver — 移行できるクラウドリソース",
      description:
        "従量課金と開発者向けAPIで、コンピュート、データベース、ストレージ、キュー、AIを提供します。",
    },
    navigation: {
      ariaLabel: "メインナビゲーション",
      brandLabel: "Takoserver ホーム",
      languageLabel: "言語",
      openConsole: "コンソール",
      readApi: "APIを見る",
    },
    hero: {
      title: "移行できるクラウドで、つくろう。",
      lede: "コンピュート、データベース、ストレージ、キュー、AIを、ひとつの開発者向けコントロールプレーンから。リソースを明示的につなぎ、使った分だけ支払えます。",
      signalsLabel: "製品の特長",
      signals: ["従量課金", "ポータブルなリソース", "開発者向けAPI"],
    },
    map: {
      legend: "リソースの配置",
      status: "配置を明示",
      resourceDescription: "実行環境から独立した、永続的なリソース契約。",
      controlPlane: "Takoserver コントロールプレーン",
      controlAction: "配置 · 接続 · 計測",
      controlItems: ["サービスカタログ", "デプロイ状態", "スコープ付き権限"],
      services: "クラウドサービス",
      serviceAction: "コンピュート · データ · AI",
      serviceItems: ["データベース", "オブジェクトストレージ", "キューとWorker"],
    },
    lanes: {
      title: "ひとつのコントロールプレーン。ふたつの明確な入口。",
      intro:
        "インフラの意味はTakoformで。すでに標準化されたプロトコルは、通常のデータサービスとして提供します。",
      infrastructureTitle: "Takoformで扱うインフラ",
      infrastructureBody:
        "正確なForm参照がリソースを表し、サービスプランがリージョンと容量を選び、Deploymentが稼働中の実体を記録します。",
      standardsTitle: "標準APIは、そのまま標準で。",
      standardsBody:
        "S3互換のオブジェクトアクセスとOpenAI互換の推論APIは、短期かつリソース単位の権限で直接利用できます。",
    },
    billing: {
      title: "使った分だけ支払う。",
      intro:
        "Takoserverの料金は、変わりにくいサービス単位で表します。細かな利用は集約してから精算するため、小さな操作を大きな料金単位へ切り上げません。",
      rows: [
        ["コンピュート", "リクエスト数 · CPUミリ秒"],
        ["データベース", "読み取り行数 · 書き込み行数 · ストレージ容量時間"],
        ["オブジェクトストレージ", "ストレージ容量時間 · Class A操作 · Class B操作"],
        ["キュー", "64 KiB単位の操作"],
        ["AI", "入力トークン · 出力トークン"],
      ],
    },
    model: {
      title: "移行できるインフラ。",
      intro:
        "Takoserverは、意味、サービスプラン、実体、接続、移行を分離します。ひとつを変えても、残りを書き直す必要はありません。",
      rows: [
        ["Form", "リソースが何を意味するかを表します。"],
        ["Offering", "リージョン、料金、分離方式、移行性を持つ選択可能なサービスプラン。"],
        ["Deployment", "論理リソースを実際に稼働させているひとつの実体。"],
        ["Attachment", "認証情報を出力へ埋め込まず、独立したリソース同士を限定権限で接続します。"],
        ["Migration", "移行元と候補Deploymentを明示的に切り替え、ロールバック期間を残します。"],
      ],
    },
    migration: {
      title: "変えるのは配置。リソースのIDではない。",
      intro:
        "サービスプラン間の移動は、不透明な更新ではなく独立したライフサイクルです。検証後、Attachmentが稼働中のDeploymentへ追従します。",
      ariaLabel: "Deploymentの移行状態",
      steps: [
        ["Active", "現在の実体がサービスを継続します。"],
        ["Candidate", "移行先を作成し、転送して、独立に検証します。"],
        ["Retained", "切り替え後も移行元を保持し、ロールバックに備えます。"],
      ],
    },
    developer: {
      title: "契約から始める。",
      intro:
        "Takoserverは、安定したDiscoveryとOpenAPIで自身を説明します。画面の奥から仕様を探し出す必要はありません。",
      rows: [
        ["HTTP API仕様", "スキーマを開く"],
        ["Takoserver Discovery", "Discoveryを読む"],
        ["Takoform Host Discovery", "Host契約を読む"],
      ],
    },
    closing: { ariaLabel: "まとめ", statement: "リソースはそのまま。動かす場所を変えられる。" },
    footer: { statement: "Takoserver · 開発者向けクラウド", discovery: "Discovery" },
  },
};

/**
 * What the API serves at its own root.
 *
 * Not a console — the console is a separate deployment on its own hostname.
 * This is the page a person lands on after typing the API's address, so its
 * whole job is to say what this is and where everything actually lives.
 *
 * The document is functional without a second request. Web fonts are an
 * optional visual enhancement and have local fallbacks.
 */
export function landingHtml(options: LandingOptions, locale: LandingLocale = "en"): string {
  const base = options.apiOrigin ?? "";
  const primaryHref = options.consoleOrigin ?? `${base}/openapi.json`;
  const copy = COPY[locale];
  const primaryLabel = options.consoleOrigin
    ? copy.navigation.openConsole
    : copy.navigation.readApi;
  const siteOrigin = options.siteOrigin?.replace(/\/$/u, "") ?? null;
  const localeMetadata = siteOrigin
    ? `<link rel="canonical" href="${siteOrigin}/${locale}/">
<link rel="alternate" href="${siteOrigin}/en/" hreflang="en">
<link rel="alternate" href="${siteOrigin}/ja/" hreflang="ja">
<link rel="alternate" href="${siteOrigin}/" hreflang="x-default">`
    : "";
  const localeNavigation = siteOrigin
    ? `<div class="locale-switcher" aria-label="${copy.navigation.languageLabel}">
        <a href="/en/" lang="en" hreflang="en"${locale === "en" ? ' aria-current="page"' : ""}>EN</a>
        <span aria-hidden="true">/</span>
        <a href="/ja/" lang="ja" hreflang="ja"${locale === "ja" ? ' aria-current="page"' : ""}>日本語</a>
      </div>`
    : "";
  const modelRows = (rows: readonly (readonly [string, string])[]): string =>
    rows
      .map(
        ([term, description]) =>
          `<div class="model-row"><dt>${term}</dt><dd>${description}</dd></div>`,
      )
      .join("\n        ");
  const migrationSteps = copy.migration.steps
    .map(
      ([state, description], index) =>
        `<div class="migration-step${index === 0 ? " migration-step--active" : ""}"><strong>${state}</strong><span>${description}</span></div>`,
    )
    .join("\n        ");
  const developerPaths = [
    `${base}/openapi.json`,
    `${base}/.well-known/takoserver`,
    `${base}/.well-known/takoform/v1alpha3`,
  ] as const;
  const developerRows = copy.developer.rows
    .map(
      ([description, action], index) =>
        `<div class="developer-row"><code>${developerPaths[index]}</code><span>${description}</span><a class="developer-action" href="${developerPaths[index]}">${action}</a></div>`,
    )
    .join("\n        ");

  return `<!doctype html>
<html lang="${locale}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${copy.meta.title}</title>
<meta name="description" content="${copy.meta.description}">
${localeMetadata}
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700&amp;family=IBM+Plex+Mono:wght@500&amp;family=Noto+Sans+JP:wght@400;500;600;700&amp;display=swap" rel="stylesheet">
<style>
/* Hallmark · genre: modern-minimal · macrostructure: Map / Diagram · theme: Coral · enrichment: Tier-A CSS system map · nav: N9 · footer: Ft5 · audience: developers · use: open Console · tone: technical
 * pre-emit critique: P5 H4 E4 S5 R5 V4
 * audit: contrast: pass (40–41) · slop: pass (42–45) · honest: pass (46) · chrome: pass (47) · tokens: pass (48) · responsive: pass (34, 49–57) · icons: pass (30)
 */
:root {
  color-scheme: light;
  --color-paper: oklch(97% 0.012 68);
  --color-paper-strong: oklch(100% 0 0);
  --color-ink: oklch(22% 0.025 43);
  --color-ink-soft: oklch(44% 0.028 45);
  --color-rule: oklch(86% 0.025 62);
  --color-rule-strong: oklch(72% 0.045 52);
  --color-accent: oklch(68% 0.21 42);
  --color-accent-strong: oklch(45% 0.19 36);
  --color-accent-soft: oklch(92% 0.055 62);
  --color-focus: oklch(45% 0.18 245);
  --color-accent-ink: oklch(99% 0.004 70);
  --color-shadow: oklch(22% 0.025 43 / 0.12);
  --color-transparent: transparent;
  --font-display: "Geist", "Avenir Next", "Helvetica Neue", sans-serif;
  --font-body: "Geist", "Avenir Next", "Helvetica Neue", sans-serif;
  --font-display-ja: "Noto Sans JP", "Hiragino Kaku Gothic ProN", "Yu Gothic", sans-serif;
  --font-body-ja: "Noto Sans JP", "Hiragino Kaku Gothic ProN", "Yu Gothic", sans-serif;
  --font-mono: "IBM Plex Mono", "SFMono-Regular", Consolas, monospace;
  --space-3xs: 0.25rem;
  --space-2xs: 0.5rem;
  --space-xs: 0.75rem;
  --space-sm: 1rem;
  --space-md: 1.5rem;
  --space-lg: 2.5rem;
  --space-xl: 4rem;
  --space-2xl: 6rem;
  --space-3xl: 8rem;
  --text-xs: 0.72rem;
  --text-sm: 0.86rem;
  --text-body: 1rem;
  --text-lede: clamp(1.05rem, 1.5vw, 1.3rem);
  --text-h2: clamp(2rem, 4.5vw, 4.5rem);
  --text-display: clamp(3rem, 5vw, 5.5rem);
  --ease-out: cubic-bezier(0.16, 1, 0.3, 1);
  --ease-in: cubic-bezier(0.7, 0, 0.84, 0);
  --dur-short: 160ms;
  --dur-medium: 240ms;
  --rule-hair: 1px;
  --rule-bold: 2px;
  --radius-sm: 0.45rem;
  --radius-md: 0.8rem;
  --page-gutter: clamp(1rem, 4vw, 4.5rem);
  --page-max: 92rem;
}

* { box-sizing: border-box; }
html, body { overflow-x: clip; }
html { background: var(--color-paper); scroll-behavior: smooth; }
body {
  margin: 0;
  min-width: 20rem;
  background: var(--color-paper);
  color: var(--color-ink);
  font-family: var(--font-body);
  font-size: var(--text-body);
  line-height: 1.55;
  letter-spacing: -0.012em;
  -webkit-font-smoothing: antialiased;
}
html[lang="ja"] body {
  font-family: var(--font-body-ja);
  letter-spacing: 0;
}
html[lang="ja"] :is(.brand, .hero h1, .section h2, .closing p) {
  font-family: var(--font-display-ja);
}
html[lang="ja"] :is(.hero h1, .section h2, .closing p) {
  line-height: 1.12;
  letter-spacing: -0.045em;
}
a { color: inherit; }
a:focus-visible {
  outline: var(--rule-bold) solid var(--color-focus);
  outline-offset: 4px;
}
.shell {
  width: min(100%, var(--page-max));
  margin-inline: auto;
  padding-inline: max(var(--page-gutter), env(safe-area-inset-left));
}
.nav {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-md);
  min-height: 5.25rem;
}
.nav-actions {
  display: flex;
  align-items: center;
  gap: var(--space-md);
}
.locale-switcher {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2xs);
  color: var(--color-ink-soft);
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  letter-spacing: 0;
  white-space: nowrap;
}
.locale-switcher a {
  display: inline-flex;
  min-height: 2.75rem;
  align-items: center;
  border-block-end: var(--rule-bold) solid var(--color-transparent);
  text-decoration: none;
}
.locale-switcher a[aria-current="page"] {
  border-block-end-color: var(--color-accent);
  color: var(--color-ink);
}
.brand {
  display: inline-flex;
  align-items: center;
  gap: var(--space-xs);
  min-height: 2.75rem;
  color: var(--color-ink);
  font-family: var(--font-display);
  font-weight: 700;
  letter-spacing: -0.035em;
  text-decoration: none;
  white-space: nowrap;
  line-height: 1;
}
.brand-mark { width: 1.65rem; height: 1.65rem; flex: none; }
.brand-mark__head { fill: var(--color-accent); }
.brand-mark__line {
  fill: none;
  stroke: var(--color-accent);
  stroke-width: 2.4;
  stroke-linecap: square;
}
.button {
  display: inline-flex;
  min-height: 2.75rem;
  align-items: center;
  justify-content: center;
  padding-inline: var(--space-md);
  border: var(--rule-hair) solid var(--color-ink);
  border-radius: var(--radius-sm);
  background: var(--color-ink);
  color: var(--color-accent-ink);
  font-size: var(--text-sm);
  font-weight: 600;
  text-decoration: none;
  white-space: nowrap;
  line-height: 1;
  transition: background-color var(--dur-short) var(--ease-out),
    border-color var(--dur-short) var(--ease-out),
    transform 100ms var(--ease-out);
}
.button:active { transform: translateY(1px); }
.button[aria-disabled="true"] {
  cursor: not-allowed;
  opacity: 0.55;
  pointer-events: none;
}
.button--quiet {
  border-color: var(--color-rule-strong);
  background: var(--color-transparent);
  color: var(--color-ink);
}
.hero {
  display: grid;
  min-height: clamp(36rem, 76dvh, 49rem);
  align-items: center;
  gap: var(--space-xl);
  padding-block: var(--space-xl) var(--space-2xl);
  border-block-start: var(--rule-hair) solid var(--color-rule);
}
.hero-copy { min-width: 0; }
.hero h1 {
  max-width: 11ch;
  margin: 0;
  font-family: var(--font-display);
  font-size: var(--text-display);
  font-style: normal;
  font-weight: 700;
  line-height: 0.94;
  letter-spacing: -0.065em;
  overflow-wrap: anywhere;
  min-width: 0;
}
.hero-lede {
  max-width: 38rem;
  margin: var(--space-lg) 0 0;
  color: var(--color-ink-soft);
  font-size: var(--text-lede);
  line-height: 1.5;
}
.hero-actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-xs);
  margin-block-start: var(--space-lg);
}
.signals {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2xs);
  margin-block-start: var(--space-xl);
}
.signal {
  padding: var(--space-3xs) var(--space-xs);
  border: var(--rule-hair) solid var(--color-rule-strong);
  border-radius: 999px;
  color: var(--color-ink-soft);
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  letter-spacing: 0;
}
.system-map {
  position: relative;
  min-width: 0;
  margin: 0;
  padding: var(--space-sm);
  border: var(--rule-hair) solid var(--color-rule-strong);
  border-radius: var(--radius-md);
  background-color: var(--color-paper-strong);
  background-image: radial-gradient(var(--color-rule) var(--rule-hair), var(--color-transparent) var(--rule-hair));
  background-size: var(--space-md) var(--space-md);
  box-shadow: 0 1.5rem 4rem -3rem var(--color-shadow);
}
.system-map__legend {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-md);
  margin: 0 0 var(--space-sm);
  padding: 0 var(--space-xs);
  color: var(--color-ink-soft);
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  letter-spacing: 0.02em;
}
.system-map__status {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2xs);
  white-space: nowrap;
}
.system-map__status::before {
  width: 0.48rem;
  height: 0.48rem;
  border-radius: 50%;
  background: var(--color-accent);
  content: "";
}
.map-grid { display: grid; gap: var(--space-xs); }
.map-node {
  min-width: 0;
  padding: var(--space-md) var(--space-sm);
  border: var(--rule-hair) solid var(--color-rule);
  border-radius: var(--radius-sm);
  background: var(--color-paper);
}
.map-node--core { border-color: var(--color-accent); }
.map-node__type {
  display: block;
  margin-block-end: var(--space-xs);
  color: var(--color-ink-soft);
  font-family: var(--font-mono);
  font-size: var(--text-xs);
}
.map-node h2 {
  min-width: 0;
  margin: 0;
  font-size: 1rem;
  line-height: 1.15;
  letter-spacing: -0.035em;
  overflow-wrap: anywhere;
}
.map-node p {
  margin: var(--space-2xs) 0 0;
  color: var(--color-ink-soft);
  font-size: var(--text-sm);
}
.map-node__list {
  display: grid;
  gap: var(--space-2xs);
  margin: var(--space-sm) 0 0;
  padding: 0;
  list-style: none;
}
.map-node__list li {
  padding-block-start: var(--space-2xs);
  border-block-start: var(--rule-hair) solid var(--color-rule);
  font-family: var(--font-mono);
  font-size: var(--text-xs);
}
.map-flow {
  display: grid;
  min-height: 2rem;
  place-items: center;
  color: var(--color-accent-strong);
  font-family: var(--font-mono);
  font-weight: 600;
}
.map-flow::before { content: "↓"; }
.section {
  padding-block: var(--space-3xl);
  border-block-start: var(--rule-hair) solid var(--color-rule);
}
.section--compact { padding-block-end: var(--space-2xl); }
.section h2 {
  max-width: 14ch;
  margin: 0;
  font-family: var(--font-display);
  font-size: var(--text-h2);
  font-style: normal;
  font-weight: 650;
  line-height: 0.98;
  letter-spacing: -0.055em;
  overflow-wrap: anywhere;
  min-width: 0;
}
.section-intro {
  max-width: 43rem;
  margin: var(--space-lg) 0 0;
  color: var(--color-ink-soft);
  font-size: var(--text-lede);
}
.lanes { margin-block-start: var(--space-2xl); }
.lane {
  display: grid;
  gap: var(--space-sm);
  padding-block: var(--space-lg);
  border-block-start: var(--rule-hair) solid var(--color-rule-strong);
}
.lane:last-child { border-block-end: var(--rule-hair) solid var(--color-rule-strong); }
.lane h3 {
  min-width: 0;
  margin: 0;
  font-size: clamp(1.25rem, 2.7vw, 2rem);
  line-height: 1.1;
  letter-spacing: -0.04em;
  overflow-wrap: anywhere;
}
.lane p { max-width: 42rem; margin: 0; color: var(--color-ink-soft); }
.lane code {
  align-self: start;
  justify-self: start;
  padding: var(--space-3xs) var(--space-2xs);
  border-radius: var(--radius-sm);
  background: var(--color-accent-soft);
  color: var(--color-accent-strong);
  font-family: var(--font-mono);
  font-size: var(--text-xs);
}
.model {
  display: grid;
  gap: 0;
  margin-block-start: var(--space-2xl);
  border-block-start: var(--rule-bold) solid var(--color-ink);
}
.model-row {
  display: grid;
  gap: var(--space-xs);
  padding-block: var(--space-md);
  border-block-end: var(--rule-hair) solid var(--color-rule);
}
.model-row dt {
  font-family: var(--font-mono);
  font-size: var(--text-sm);
  font-weight: 500;
}
.model-row dd { margin: 0; color: var(--color-ink-soft); }
.migration {
  display: grid;
  gap: var(--space-xs);
  margin-block-start: var(--space-2xl);
}
.migration-step {
  position: relative;
  padding: var(--space-md);
  border: var(--rule-hair) solid var(--color-rule);
  border-radius: var(--radius-sm);
  background: var(--color-paper-strong);
}
.migration-step strong { display: block; font-size: 1rem; }
.migration-step span {
  display: block;
  margin-block-start: var(--space-2xs);
  color: var(--color-ink-soft);
  font-size: var(--text-sm);
}
.migration-step--active { border-color: var(--color-accent); }
.migration-step--active::after {
  position: absolute;
  inset-block-start: var(--space-sm);
  inset-inline-end: var(--space-sm);
  width: 0.52rem;
  height: 0.52rem;
  border-radius: 50%;
  background: var(--color-accent);
  content: "";
}
.developer-links {
  display: grid;
  margin-block-start: var(--space-2xl);
  border-block-start: var(--rule-bold) solid var(--color-ink);
}
.developer-row {
  display: grid;
  gap: var(--space-2xs);
  padding-block: var(--space-md);
  border-block-end: var(--rule-hair) solid var(--color-rule);
}
.developer-row code {
  min-width: 0;
  font-family: var(--font-mono);
  font-size: var(--text-sm);
  overflow-wrap: anywhere;
}
.developer-row span { color: var(--color-ink-soft); font-size: var(--text-sm); }
.developer-action {
  align-self: center;
  justify-self: start;
  min-height: 2.75rem;
  display: inline-flex;
  align-items: center;
  color: var(--color-accent-strong);
  font-size: var(--text-sm);
  font-weight: 600;
  line-height: 1;
  white-space: nowrap;
}
.closing {
  padding-block: var(--space-3xl) var(--space-2xl);
  border-block-start: var(--rule-hair) solid var(--color-rule);
}
.closing p {
  max-width: 14ch;
  margin: 0;
  font-family: var(--font-display);
  font-size: clamp(2.5rem, 7vw, 6.8rem);
  font-weight: 700;
  line-height: 0.93;
  letter-spacing: -0.06em;
  overflow-wrap: anywhere;
  min-width: 0;
}
.footer {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-md);
  padding-block: var(--space-lg) max(var(--space-lg), env(safe-area-inset-bottom));
  border-block-start: var(--rule-bold) solid var(--color-ink);
  color: var(--color-ink-soft);
  font-size: var(--text-sm);
}
.footer-links { display: flex; flex-wrap: wrap; gap: var(--space-md); }
.footer a { min-height: 2.75rem; display: inline-flex; align-items: center; line-height: 1; white-space: nowrap; }
a:active { color: var(--color-accent-strong); }
@media (hover: hover) and (pointer: fine) {
  .brand:hover, .locale-switcher a:hover, .footer a:hover { color: var(--color-accent-strong); }
  .button:hover { background: var(--color-accent-strong); border-color: var(--color-accent-strong); }
  .button--quiet:hover { background: var(--color-accent-soft); color: var(--color-accent-strong); }
  .developer-action:hover { color: var(--color-ink); }
}
@media (pointer: coarse) {
  .button, .locale-switcher a, .developer-action, .footer a { min-height: 3rem; }
}
@media (max-width: 30rem) {
  .nav { flex-wrap: wrap; padding-block: var(--space-sm); }
  .nav-actions { width: 100%; justify-content: space-between; }
}
@media (min-width: 40rem) {
  .lane { grid-template-columns: minmax(0, 0.75fr) minmax(0, 1.45fr); align-items: start; }
  .lane code { grid-column: 2; }
  .model-row { grid-template-columns: minmax(8rem, 0.6fr) minmax(0, 1.4fr); }
  .migration { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .developer-row { grid-template-columns: minmax(0, 1.25fr) minmax(0, 0.75fr) auto; align-items: center; }
}
@media (min-width: 60rem) {
  .hero { grid-template-columns: minmax(0, 0.9fr) minmax(32rem, 1.1fr); gap: var(--space-xl); }
  .map-grid { grid-template-columns: minmax(0, 1fr) var(--space-lg) minmax(0, 1.14fr) var(--space-lg) minmax(0, 1fr); align-items: stretch; }
  .map-flow::before { content: "→"; }
  .section-intro { margin-inline-start: 34%; }
  .lanes, .model, .migration, .developer-links { margin-inline-start: 17%; }
}
@media (min-width: 90rem) {
  .hero { gap: var(--space-2xl); }
}
@media (prefers-reduced-motion: reduce) {
  html { scroll-behavior: auto; }
  .button { transition: none; }
  .button:active { transform: none; }
}
</style>
</head>
<body>
<div class="shell">
  <nav class="nav" aria-label="${copy.navigation.ariaLabel}">
    <a class="brand" href="${locale === "ja" ? "/ja/" : "/en/"}" aria-label="${copy.navigation.brandLabel}">
      <svg class="brand-mark" viewBox="0 0 28 28" aria-hidden="true">
        <rect class="brand-mark__head" x="7" y="3" width="14" height="10" rx="2"/>
        <path class="brand-mark__line" d="M8 12v8c0 3-4 2-4 5M12 12v10c0 3-2 3-2 3M16 12v10c0 3 2 3 2 3M20 12v8c0 3 4 2 4 5"/>
      </svg>
      <span>Takoserver</span>
    </a>
    <div class="nav-actions">
      ${localeNavigation}
      <a class="button" href="${primaryHref}">${primaryLabel}</a>
    </div>
  </nav>

  <main>
    <section class="hero">
      <div class="hero-copy">
        <h1>${copy.hero.title}</h1>
        <p class="hero-lede">${copy.hero.lede}</p>
        <div class="hero-actions">
          <a class="button" href="${primaryHref}">${primaryLabel}</a>
          <a class="button button--quiet" href="${base}/openapi.json">${copy.navigation.readApi}</a>
        </div>
        <div class="signals" aria-label="${copy.hero.signalsLabel}">
          <span class="signal">${copy.hero.signals[0]}</span>
          <span class="signal">${copy.hero.signals[1]}</span>
          <span class="signal">${copy.hero.signals[2]}</span>
        </div>
      </div>

      <figure class="system-map">
        <figcaption class="system-map__legend">
          <span>${copy.map.legend}</span>
          <span class="system-map__status">${copy.map.status}</span>
        </figcaption>
        <div class="map-grid">
          <article class="map-node">
            <span class="map-node__type">Takoform Form</span>
            <h2>ObjectBucket</h2>
            <p>${copy.map.resourceDescription}</p>
          </article>
          <div class="map-flow" aria-hidden="true"></div>
          <article class="map-node map-node--core">
            <span class="map-node__type">${copy.map.controlPlane}</span>
            <h2>${copy.map.controlAction}</h2>
            <ul class="map-node__list">
              <li>${copy.map.controlItems[0]}</li>
              <li>${copy.map.controlItems[1]}</li>
              <li>${copy.map.controlItems[2]}</li>
            </ul>
          </article>
          <div class="map-flow" aria-hidden="true"></div>
          <article class="map-node">
            <span class="map-node__type">${copy.map.services}</span>
            <h2>${copy.map.serviceAction}</h2>
            <ul class="map-node__list">
              <li>${copy.map.serviceItems[0]}</li>
              <li>${copy.map.serviceItems[1]}</li>
              <li>${copy.map.serviceItems[2]}</li>
            </ul>
          </article>
        </div>
      </figure>
    </section>

    <section class="section" aria-labelledby="lanes-title">
      <h2 id="lanes-title">${copy.lanes.title}</h2>
      <p class="section-intro">${copy.lanes.intro}</p>
      <div class="lanes">
        <article class="lane">
          <h3>${copy.lanes.infrastructureTitle}</h3>
          <p>${copy.lanes.infrastructureBody}</p>
          <code>Form → Offering → Deployment</code>
        </article>
        <article class="lane">
          <h3>${copy.lanes.standardsTitle}</h3>
          <p>${copy.lanes.standardsBody}</p>
          <code>S3 · OpenAI</code>
        </article>
      </div>
    </section>

    <section class="section" aria-labelledby="billing-title">
      <h2 id="billing-title">${copy.billing.title}</h2>
      <p class="section-intro">${copy.billing.intro}</p>
      <dl class="model">
        ${modelRows(copy.billing.rows)}
      </dl>
    </section>

    <section class="section" aria-labelledby="model-title">
      <h2 id="model-title">${copy.model.title}</h2>
      <p class="section-intro">${copy.model.intro}</p>
      <dl class="model">
        ${modelRows(copy.model.rows)}
      </dl>
    </section>

    <section class="section section--compact" aria-labelledby="migration-title">
      <h2 id="migration-title">${copy.migration.title}</h2>
      <p class="section-intro">${copy.migration.intro}</p>
      <div class="migration" aria-label="${copy.migration.ariaLabel}">
        ${migrationSteps}
      </div>
    </section>

    <section class="section" aria-labelledby="developer-title">
      <h2 id="developer-title">${copy.developer.title}</h2>
      <p class="section-intro">${copy.developer.intro}</p>
      <div class="developer-links">
        ${developerRows}
      </div>
    </section>

    <section class="closing" aria-label="${copy.closing.ariaLabel}">
      <p>${copy.closing.statement}</p>
    </section>
  </main>

  <footer class="footer">
    <span>${copy.footer.statement}</span>
    <span class="footer-links">
      <a href="${base}/openapi.json">OpenAPI</a>
      <a href="${base}/.well-known/takoserver">${copy.footer.discovery}</a>
    </span>
  </footer>
</div>
</body>
</html>
`;
}
