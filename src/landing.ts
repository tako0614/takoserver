/**
 * The page Takoserver shows a person who arrives without an application.
 *
 * One page, rendered in two places: the API answers it at its own root, and the
 * apex serves it as files. Writing it twice would produce two descriptions of
 * one product, and they would disagree within a month.
 *
 * The page tells the product's own story: a cloud you run yourself, and what
 * you deploy to it with Takoform. Installing it is the main path; the console
 * and the API are how you look after what you deployed.
 */

export interface LandingOptions {
  /** Where the console is, if this deployment has one. */
  readonly consoleOrigin: string | null;
  /** Prefix for the API links. Null when the page is served by the API. */
  readonly apiOrigin: string | null;
  /** Static locale for the page body; the API root defaults to English. */
  readonly locale?: "en" | "ja";
}

const REPOSITORY = "https://github.com/tako0614/takoserver";
const GUIDE = `${REPOSITORY}/blob/main/docs/self-host-operations.md`;
const INSTALL_GUIDE = `${GUIDE}#first-install-and-first-use`;
const DEPLOY_STEPS = `${GUIDE}#6-seed-held-artifacts`;
const DOCKER_GUIDE = `${REPOSITORY}/blob/main/docs/self-host-docker.md`;
const SECURITY_GUIDE = `${REPOSITORY}/blob/main/docs/self-host-security.md`;
const V2_REFERENCE = `${REPOSITORY}/blob/main/docs/takoform-v2.md`;
const PREREQUISITES = `${GUIDE}#1-prerequisites`;

const landingMessages = {
  en: {
    description:
      "Takoserver is an open-source cloud you host yourself. Deploy Workers and their SQLite, KV, object storage and queues to your own machine with Takoform.",
    skip: "Skip to content",
    lead: "Deploy Takoform.\nRun your own cloud.",
    lede: "Takoserver is an open-source cloud that runs on your own Linux machine. Deploy Workers and their SQLite, KV, object storage and queues from Takoform definitions, and operate them yourself.",
    install: "Read the install guide",
    source: "Source code",
    preview: "Resources in the Takoserver Console · public sample data",
    previewAlt:
      "The Takoserver Console listing the Resources of a Worker named hello and a SQLite database, all applied, with public sample data",
    formsTitle: "What you can deploy",
    formsBody:
      "A Host serves exactly the Forms its configuration composes. Before relying on one, ask your Host's support endpoint about its exact Form URL.",
    artifactsTitle: "Artifacts",
    artifactsBody:
      "Worker code, static files and SQL migrations, kept by URL and SHA-256. Each needs only Bun and that Form's block in TAKOSERVER_TAKOFORM_V2_CONFIG.",
    workersTitle: "Workers and HTTPS",
    workersBody:
      "Create a Worker, cut a version, choose which version serves, run it on a schedule and publish it at an HTTPS hostname. Needs the complete local Worker profile (step 4 below); WorkerEndpoint also needs the HTTPS listener on port 443.",
    dataTitle: "Data",
    dataBody:
      "SQLite databases, KV namespaces and object buckets that a Worker uses through Bindings. Needs the complete local Worker profile; SQLiteMigrationApplication also needs a sqliteMigrationSet block.",
    asyncTitle: "Queues, actors and workflows",
    asyncBody:
      "At-least-once queues and their consumers, actors that keep state, and durable workflows. Needs the complete local Worker profile.",
    hostTitle: "Run your own Host",
    hostStep1:
      "On Linux x86-64 with Bun, check out a reviewed commit and install its locked dependencies.",
    hostStep2: "Set the public HTTPS origin, the v2 configuration and a persistent cursor key.",
    hostStep3:
      "Start it. Without an identity provider, the first boot prints a single-use operator sign-in assertion.",
    hostStep4:
      "For Workers, add the complete local Worker profile: the pinned workerd, Actor and Workflow boot with the Workflow execution guard, all five private data planes, and both bundle blocks on selfhost-v2-worker-primary. Publishing at a hostname also needs HTTPS on port 443.",
    hostNote:
      "Serve the API through your own HTTPS front end; do not expose the listener directly. To try the API, sign-in, organizations and keys without running Workers, use Docker.",
    prerequisites: "Prerequisites",
    docker: "Try it in Docker",
    security: "Self-host security",
    deployTitle: "Deploy one Worker",
    deployBody:
      "Steps 6 to 9 of the install guide, condensed; $V2 and $KEY come from its step 5. Host API v2 accepts each create as an Operation; for 24 hours, sending it again with the same idempotency-key returns that Operation instead of a second Resource.",
    workerStep: "is the Worker itself. Its versions, deployment and endpoint refer to it.",
    bundleStep: "names the bytes of worker.js held by the Host, by URL and SHA-256.",
    versionStep: "pairs that bundle with its fetch handler.",
    deploymentStep: "chooses which version serves: here one version, weight 10000.",
    endpointStep: "publishes the Worker at an HTTPS hostname.",
    resultLabel: "Then request it:",
    deployMore: "Steps 6 to 9 in the guide",
    afterTitle: "After you deploy",
    consoleTitle: "In the console",
    consoleBody:
      "The console is a separate static app built from this repository. Serve it on its own origin next to your API and name that origin in the Host's settings. There you sign in, create the organization that owns your Resources, issue API keys, and see each Resource's declared and observed state.",
    consoleHost: "Open this Host's console",
    consoleSite: "takoserver.com's own console",
    apiTitle: "With the API",
    apiBody:
      "Do the same from your own tools over Host API v2. Start by asking your Host whether it supports the exact Form URL you plan to use; $HOST is its public origin.",
    reference: "Host API v2 reference",
    openapi: "OpenAPI description",
    discovery: "Takoform Host discovery",
    product: "Product discovery",
  },
  ja: {
    description:
      "Takoserverは、自分でホストするオープンソースのクラウドです。WorkerとそのSQLite・KV・オブジェクトストレージ・キューを、Takoformで自分のマシンへデプロイできます。",
    skip: "本文へ移動",
    lead: "Takoformを、\n自分のクラウドへ。",
    lede: "Takoserverは、自分のLinuxマシンで動かすオープンソースのクラウドです。WorkerとそのSQLite・KV・オブジェクトストレージ・キューを、Takoformの定義からデプロイして運用できます。",
    install: "導入手順を読む",
    source: "ソースコード",
    preview: "Takoserver Consoleのリソース一覧（公開用サンプルデータ）",
    previewAlt:
      "helloというWorkerのリソース一式とSQLiteデータベースがすべて反映済みになっている、Takoserver Consoleのリソース一覧（公開用サンプルデータ）",
    formsTitle: "デプロイできるもの",
    formsBody:
      "Hostは、設定で組み合わせたFormだけを提供します。使う前に、HostのsupportエンドポイントでForm URLごとに対応を確認できます。",
    artifactsTitle: "成果物",
    artifactsBody:
      "Workerのコード・静的ファイル・SQLのマイグレーションを、URLとSHA-256で固定して保持します。Bunと、TAKOSERVER_TAKOFORM_V2_CONFIGにあるそのFormのblockだけで使えます。",
    workersTitle: "Workerと公開",
    workersBody:
      "Workerを作り、版を作り、配信する版を決め、定期実行し、HTTPSのホスト名で公開します。完全なlocal Worker profile（下の手順4）が必要で、WorkerEndpointには443番のHTTPS listenerも必要です。",
    dataTitle: "データ",
    dataBody:
      "WorkerがBindingで使うSQLiteデータベース、KV、オブジェクトストレージです。完全なlocal Worker profileが必要で、SQLiteMigrationApplicationにはsqliteMigrationSetのblockも必要です。",
    asyncTitle: "キュー・Actor・Workflow",
    asyncBody:
      "少なくとも一度届くキューとその受信、状態を持つActor、永続するWorkflowです。完全なlocal Worker profileが必要です。",
    hostTitle: "自分のHostを動かす",
    hostStep1:
      "Linux x86-64とBunを用意し、reviewしたcommitを取り出して、lockfileで固定された依存関係をインストールします。",
    hostStep2: "公開HTTPS origin、v2設定、永続するcursor鍵を設定します。",
    hostStep3:
      "起動します。IDプロバイダーが未設定なら、初回起動時に一度だけ使える運営者サインイン用のassertionが表示されます。",
    hostStep4:
      "Workerには完全なlocal Worker profileを追加します。固定版のworkerd、ActorとWorkflowの起動とWorkflow execution guard、5つのprivate data plane、selfhost-v2-worker-primaryに向けた2つのbundle blockです。ホスト名で公開するには443番のHTTPSも必要です。",
    hostNote:
      "APIは自分で用意したHTTPSフロントエンドの背後で公開し、listenerを直接公開しないでください。Workerを動かさずにAPI・サインイン・組織・APIキーを試すならDockerを使えます。",
    prerequisites: "前提条件",
    docker: "Dockerで試す",
    security: "セルフホストのセキュリティ",
    deployTitle: "Workerを1つデプロイする",
    deployBody:
      "導入手順書のstep 6〜9を短くまとめた流れです。$V2と$KEYは手順書のstep 5で用意します。Host API v2は作成をOperationとして受け付けます。24時間以内に同じidempotency-keyで送り直すと、2つ目のリソースは作らず同じOperationを返します。",
    workerStep: "Workerそのものです。版・配信・公開先はこれを参照します。",
    bundleStep: "Hostに保持したworker.jsの内容を、URLとSHA-256で指定します。",
    versionStep: "そのbundleとfetchハンドラーを組み合わせた版です。",
    deploymentStep: "どの版を配信するかを決めます。ここでは1つの版を重み10000で配信します。",
    endpointStep: "WorkerをHTTPSのホスト名で公開します。",
    resultLabel: "公開したら、リクエストします。",
    deployMore: "手順書のstep 6〜9",
    afterTitle: "デプロイしたあと",
    consoleTitle: "コンソールで",
    consoleBody:
      "コンソールは、このリポジトリからbuildする独立した静的アプリです。APIと並ぶ別のoriginで配信し、そのoriginをHostの設定に指定します。そこでサインインし、リソースを所有する組織を作り、APIキーを発行して、各リソースの宣言と観測した状態を確認します。",
    consoleHost: "このHostのコンソールを開く",
    consoleSite: "takoserver.com自身のコンソール",
    apiTitle: "APIで",
    apiBody:
      "同じ操作を、自分のツールからHost API v2で行えます。まず、使う予定のForm URLに自分のHostが対応しているかを確認します。$HOSTはHostの公開originです。",
    reference: "Host API v2 リファレンス",
    openapi: "OpenAPI仕様",
    discovery: "Takoform Hostディスカバリー",
    product: "製品ディスカバリー",
  },
} as const;

/** The Forms a Bun self-host can compose, and what each group needs (docs/takoform-v2.md). */
const FORM_GROUPS = [
  {
    title: "artifactsTitle",
    body: "artifactsBody",
    forms: ["WorkerBundle 0.2.0", "StaticAssetBundle 0.2.0", "SQLiteMigrationSet 0.2.0"],
  },
  {
    title: "workersTitle",
    body: "workersBody",
    forms: [
      "ModuleWorker 0.3.0",
      "WorkerVersion 0.5.0",
      "WorkerDeployment 0.4.0",
      "WorkerCronTrigger 0.3.0",
      "WorkerEndpoint 0.3.0",
    ],
  },
  {
    title: "dataTitle",
    body: "dataBody",
    forms: [
      "SQLiteDatabase 0.2.0",
      "SQLiteMigrationApplication 0.2.0",
      "EdgeKVNamespace 0.2.0",
      "ObjectBucket 0.2.0",
    ],
  },
  {
    title: "asyncTitle",
    body: "asyncBody",
    forms: [
      "AtLeastOnceQueue 0.2.0",
      "QueueConsumer 0.3.0",
      "ActorNamespace 0.3.0",
      "DurableWorkflow 0.3.0",
    ],
  },
] as const;

/** The Worker chain of the install guide, in the order it is created. */
const DEPLOY_CHAIN = [
  ["ModuleWorker", "hello", "workerStep"],
  ["WorkerBundle", "hello-bundle-v1", "bundleStep"],
  ["WorkerVersion", "hello-version-v1", "versionStep"],
  ["WorkerDeployment", "hello-deployment", "deploymentStep"],
  ["WorkerEndpoint", "hello-endpoint", "endpointStep"],
] as const;

/** The product mark — the pixel tako, drawn once so the page can place it
 *  at any scale without duplicating 46 rects. */
const TAKO_RECTS =
  '<rect x="9" y="0" width="17" height="8" fill="var(--accent)"/><rect x="8" y="1" width="1" height="30" fill="var(--accent)"/><rect x="26" y="1" width="1" height="33" fill="var(--accent)"/><rect x="7" y="2" width="1" height="30" fill="var(--accent)"/><rect x="27" y="2" width="1" height="30" fill="var(--accent)"/><rect x="6" y="3" width="1" height="31" fill="var(--accent)"/><rect x="28" y="3" width="1" height="22" fill="var(--accent)"/><rect x="29" y="4" width="1" height="20" fill="var(--accent)"/><rect x="5" y="5" width="1" height="29" fill="var(--accent)"/><rect x="4" y="6" width="1" height="15" fill="var(--accent)"/><rect x="30" y="6" width="1" height="17" fill="var(--accent)"/><rect x="3" y="7" width="1" height="13" fill="var(--accent)"/><rect x="31" y="7" width="1" height="15" fill="var(--accent)"/><rect x="2" y="8" width="1" height="9" fill="var(--accent)"/><rect x="9" y="8" width="4" height="23" fill="var(--accent)"/><rect x="15" y="8" width="5" height="3" fill="var(--accent)"/><rect x="22" y="8" width="4" height="23" fill="var(--accent)"/><rect x="32" y="8" width="1" height="13" fill="var(--accent)"/><rect x="1" y="10" width="1" height="4" fill="var(--accent)"/><rect x="13" y="10" width="2" height="21" fill="var(--accent)"/><rect x="20" y="10" width="2" height="24" fill="var(--accent)"/><rect x="33" y="10" width="1" height="10" fill="var(--accent)"/><rect x="17" y="11" width="3" height="20" fill="var(--accent)"/><rect x="16" y="12" width="1" height="1" fill="var(--accent)"/><rect x="15" y="14" width="1" height="20" fill="var(--accent)"/><rect x="16" y="16" width="1" height="18" fill="var(--accent)"/><rect x="0" y="20" width="3" height="2" fill="var(--accent)"/><rect x="1" y="22" width="2" height="2" fill="var(--accent)"/><rect x="3" y="23" width="2" height="8" fill="var(--accent)"/><rect x="2" y="24" width="1" height="2" fill="var(--accent)"/><rect x="28" y="27" width="1" height="4" fill="var(--accent)"/><rect x="29" y="28" width="1" height="3" fill="var(--accent)"/><rect x="2" y="29" width="1" height="2" fill="var(--accent)"/><rect x="30" y="29" width="1" height="2" fill="var(--accent)"/><rect x="1" y="30" width="1" height="1" fill="var(--accent)"/><rect x="31" y="30" width="1" height="1" fill="var(--accent)"/><rect x="10" y="31" width="3" height="1" fill="var(--accent)"/><rect x="17" y="31" width="1" height="1" fill="var(--accent)"/><rect x="22" y="31" width="1" height="1" fill="var(--accent)"/><rect x="25" y="31" width="1" height="3" fill="var(--accent)"/><rect x="10" y="32" width="2" height="2" fill="var(--accent)"/><rect x="13" y="8" width="2" height="2" fill="var(--mark-face)"/><rect x="20" y="8" width="2" height="2" fill="var(--mark-face)"/><rect x="15" y="11" width="2" height="1" fill="var(--mark-face)"/><rect x="15" y="12" width="1" height="2" fill="var(--mark-face)"/><rect x="16" y="13" width="1" height="3" fill="var(--mark-face)"/>';
const takoMark = (size: number, cls = "") =>
  `<svg viewBox="0 0 34 34" width="${size}" height="${size}" shape-rendering="crispEdges" class="${cls}" aria-hidden="true">${TAKO_RECTS}</svg>`;

/*
 * The product site's neutral surfaces: white and a near-black dark scheme
 * that follows the device, with the Console's restrained red as the only
 * accent. Content sits in a 1160px column; the real Console is the image.
 */
const pageStyles = `
:root {
  color-scheme: light dark;
  --ink-1: #18181b; --ink-2: #56565d; --ink-3: #6b6b73;
  --surface-0: #ffffff; --surface-2: #f5f5f6; --surface-3: #ececee;
  --line-1: #e7e7ea; --line-2: #d6d6da;
  --accent: #b0301f; --mark-face: #ffffff; --shadow: #00000014;
  --sans: ui-sans-serif, system-ui, -apple-system, "Segoe UI", "Helvetica Neue", "Hiragino Sans", "Noto Sans JP", sans-serif;
  --display: "Bricolage Grotesque", var(--sans);
  --mono: ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace;
}
@media (prefers-color-scheme: dark) {
  :root {
    --ink-1: #f3f3f4; --ink-2: #b2b2ba; --ink-3: #929299;
    --surface-0: #0a0a0b; --surface-2: #161618; --surface-3: #1f1f22;
    --line-1: #2a2a2e; --line-2: #3a3a40;
    --accent: #e45c46; --mark-face: #161618; --shadow: #00000066;
  }
}
* { box-sizing: border-box; }
html, body { overflow-x: clip; }
body { margin: 0; background: var(--surface-0); color: var(--ink-1); font: 400 16px/1.8 var(--sans); -webkit-font-smoothing: antialiased; letter-spacing: -0.01em; }
a { color: inherit; }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 4px; }
.shell { width: min(1160px, calc(100% - 80px)); margin: 0 auto; }
.skip { position: absolute; top: -100px; left: 16px; padding: 8px 12px; background: var(--surface-0); z-index: 2; }
.skip:focus { top: 12px; }
.top { height: 88px; display: flex; align-items: center; justify-content: space-between; gap: 24px; }
.brand { display: inline-flex; align-items: center; gap: 10px; font-size: 17px; font-weight: 550; letter-spacing: -0.035em; text-decoration: none; }
.brand svg { flex: none; }
.top-link { font-size: 13px; color: var(--ink-2); text-decoration: none; white-space: nowrap; }
.top-link:hover { color: var(--ink-1); }

.hero { padding: 72px 0 48px; text-align: center; }
.hero-title { display: flex; align-items: center; justify-content: center; gap: 20px; }
.hero-title svg { width: 56px; height: 56px; }
h1 { margin: 0; font-family: var(--display); font-size: clamp(42px, 5.5vw, 68px); font-weight: 500; line-height: 1.15; letter-spacing: -0.055em; overflow-wrap: anywhere; min-width: 0; }
.lead { margin: 24px auto 0; font-size: clamp(20px, 2.2vw, 26px); font-weight: 500; line-height: 1.55; color: var(--ink-1); white-space: pre-line; text-wrap: balance; word-break: auto-phrase; }
.lede { margin: 18px auto 0; max-width: 40em; color: var(--ink-2); font-size: 15px; line-height: 1.9; }
.actions { display: flex; justify-content: center; align-items: center; gap: 12px; margin-top: 32px; flex-wrap: wrap; }
.pill { display: inline-flex; align-items: center; justify-content: center; gap: 12px; min-height: 48px; padding: 12px 24px; border-radius: 999px; font-size: 14px; font-weight: 500; text-decoration: none; white-space: nowrap; transition: opacity 120ms ease-out, border-color 120ms ease-out; }
.pill.external::after { content: "\\2197"; }
.pill.primary { background: var(--ink-1); color: var(--surface-0); border: 1px solid var(--ink-1); }
.pill.secondary { background: var(--surface-2); border: 1px solid var(--line-1); }
.pill:active { opacity: 0.72; }
@media (hover: hover) { .pill.primary:hover { opacity: 0.86; } .pill.secondary:hover { border-color: var(--ink-3); } }

.preview { margin: 64px 0 0; }
.frame { padding: 12px; background: var(--surface-2); border: 1px solid var(--line-1); border-radius: 22px; box-shadow: 0 24px 64px -40px var(--shadow); }
.frame picture { display: block; overflow: hidden; border: 1px solid var(--line-1); border-radius: 12px; }
.frame img { display: block; width: 100%; height: auto; }
.preview figcaption { margin-top: 16px; color: var(--ink-3); font-size: 12px; text-align: center; word-break: auto-phrase; }

section.block { padding: 96px 0 0; }
h2 { margin: 0; font-family: var(--display); font-size: clamp(28px, 3.2vw, 40px); font-weight: 500; line-height: 1.3; letter-spacing: -0.045em; text-wrap: balance; word-break: auto-phrase; }
.intro { margin: 16px 0 0; max-width: 44em; color: var(--ink-2); font-size: 15px; }
h3 { margin: 0; font-size: 17px; font-weight: 600; letter-spacing: -0.02em; }

.forms { margin: 40px 0 0; padding: 0; border-top: 1px solid var(--line-1); }
.forms > div { display: grid; grid-template-columns: minmax(0, 0.9fr) minmax(0, 1.6fr); gap: 16px 48px; padding: 28px 0; border-bottom: 1px solid var(--line-1); }
.forms dt { margin: 0; }
.forms dt p { margin: 8px 0 0; color: var(--ink-2); font-size: 14px; max-width: 28em; }
.forms dd { margin: 0; display: flex; flex-wrap: wrap; gap: 8px; align-content: start; }
.forms code { padding: 4px 10px; border: 1px solid var(--line-1); border-radius: 999px; background: var(--surface-2); font: 13px/1.6 var(--mono); white-space: nowrap; }

.deploy { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 48px; margin-top: 40px; align-items: start; }
.chain { margin: 0; padding: 0; list-style: none; counter-reset: step; }
.chain li { counter-increment: step; display: grid; grid-template-columns: 32px minmax(0, 1fr); gap: 0 12px; padding: 16px 0; border-top: 1px solid var(--line-1); }
.chain li:last-child { border-bottom: 1px solid var(--line-1); }
.chain li::before { content: counter(step); grid-row: 1 / span 2; width: 28px; height: 28px; display: grid; place-items: center; border-radius: 999px; background: var(--surface-3); color: var(--ink-2); font: 500 13px/1 var(--mono); }
.chain strong { font: 600 14px/1.6 var(--mono); letter-spacing: 0; }
.chain strong span { color: var(--ink-3); font-weight: 400; white-space: nowrap; }
.chain p { margin: 2px 0 0; color: var(--ink-2); font-size: 14px; }
.code { display: grid; gap: 16px; min-width: 0; }
.code p { margin: 0; color: var(--ink-2); font-size: 14px; }
pre { margin: 0; padding: 16px 20px; border: 1px solid var(--line-1); border-radius: 14px; background: var(--surface-2); color: var(--ink-1); font: 13px/1.7 var(--mono); letter-spacing: 0; overflow-x: auto; }
pre .file { display: block; margin-bottom: 8px; color: var(--ink-3); }
pre .out { color: var(--accent); }
.more { display: flex; flex-wrap: wrap; gap: 8px 24px; margin: 24px 0 0; }
.more a { font-size: 14px; font-weight: 500; text-decoration: underline; text-decoration-color: var(--line-2); text-underline-offset: 4px; white-space: nowrap; }
.more a:hover { text-decoration-color: var(--ink-1); }

.host { display: grid; grid-template-columns: minmax(0, 1.6fr) minmax(0, 1fr); gap: 48px; margin-top: 40px; align-items: start; }
.host aside { min-width: 0; padding-top: 16px; }
.host aside .note { margin-top: 0; }
.steps { margin: 0; padding: 0; list-style: none; counter-reset: host; }
.steps > li { counter-increment: host; display: grid; grid-template-columns: 32px minmax(0, 1fr); gap: 0 12px; padding: 16px 0; border-top: 1px solid var(--line-1); }
.steps > li::before { content: counter(host); grid-row: 1 / span 3; width: 28px; height: 28px; display: grid; place-items: center; border-radius: 999px; background: var(--surface-3); color: var(--ink-2); font: 500 13px/1 var(--mono); }
.steps > li > * { grid-column: 2; min-width: 0; }
.steps p { margin: 0; color: var(--ink-1); font-size: 15px; }
.steps pre { margin-top: 12px; }
.chips { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
.chips code { padding: 4px 10px; border: 1px solid var(--line-1); border-radius: 999px; background: var(--surface-2); font: 12.5px/1.6 var(--mono); overflow-wrap: anywhere; }
.note { margin: 24px 0 0; max-width: 44em; color: var(--ink-2); font-size: 14px; }

.after { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 48px; margin-top: 40px; }
.after > div { min-width: 0; padding-top: 24px; border-top: 1px solid var(--line-1); }
.after p { margin: 12px 0 0; color: var(--ink-2); font-size: 15px; }
.after .chips code { font-size: 12px; border-radius: 8px; }
.after pre { margin-top: 16px; }
.actions.start { justify-content: flex-start; }
.after .actions { margin-top: 20px; }

footer { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 16px; margin-top: 120px; padding: 24px 0 32px; border-top: 1px solid var(--line-1); color: var(--ink-3); font-size: 13px; }
.footer-brand { color: var(--ink-1); font-weight: 550; }
.footer-links { display: flex; flex-wrap: wrap; gap: 4px 24px; }
.footer-links a { display: inline-flex; align-items: center; min-height: 44px; text-decoration: none; white-space: nowrap; }
.footer-links a:hover { color: var(--ink-1); }

.error { min-height: 100svh; display: grid; place-items: center; padding: 24px; }
.error main { max-width: 28rem; }
.error .code-label { margin: 24px 0 8px; color: var(--ink-3); font: 13px var(--mono); }
.error h1 { font-size: 32px; }
.error p { margin: 12px 0 0; color: var(--ink-2); }
.error .pill { margin-top: 28px; }

@media (min-width: 761px) and (max-width: 1100px) { .preview .frame { max-width: 848px; margin-inline: auto; } }
@media (max-width: 760px) {
  .shell { width: calc(100% - 32px); }
  .top { height: 72px; }
  .hero { padding: 48px 0 32px; }
  .hero-title { gap: 12px; }
  .hero-title svg { width: 36px; height: 36px; }
  h1 { font-size: clamp(34px, 8.7vw, 56px); }
  .lead { font-size: 19px; margin-top: 20px; }
  .actions { margin-top: 28px; gap: 8px; }
  .pill { min-height: 44px; padding: 10px 18px; font-size: 13px; }
  .preview { margin-top: 40px; }
  .frame { padding: 6px; border-radius: 16px; }
  .frame picture { border-radius: 10px; }
  section.block { padding-top: 64px; }
  .forms > div, .deploy, .after, .host { grid-template-columns: minmax(0, 1fr); gap: 24px; }
  .steps > li > pre { grid-column: 1 / -1; }
  footer { margin-top: 80px; }
}
@media (prefers-reduced-motion: reduce) { .pill { transition: none; } }
`;

export function landingHtml(options: LandingOptions): string {
  const locale = options.locale ?? "en";
  const copy = landingMessages[locale];
  const base = options.apiOrigin ?? "";
  // The public site ships its font and the Console screenshots as files; the
  // API answering its own root stays a single self-contained response.
  const siteAssets = options.apiOrigin !== null;
  // Commands target the reader's own Host. On the public site that is $HOST;
  // the API's own root fills in the origin it was read from.
  const commandOrigin = siteAssets ? "$HOST" : `<span data-origin>$HOST</span>`;
  const text = (key: keyof typeof copy, tag = "span", attributes = "") =>
    `<${tag}${attributes} data-i18n="${key}">${copy[key]}</${tag}>`;
  const screen = (shape: "desktop" | "tablet" | "mobile", theme: "light" | "dark") =>
    `/screens/console-${shape}-${theme}-{lang}.webp`;
  const localized = (template: string) => template.replace("{lang}", locale);
  const preview = siteAssets
    ? `<figure class="preview">
<div class="frame"><picture>
<source media="(max-width: 760px) and (prefers-color-scheme: dark)" srcset="${localized(screen("mobile", "dark"))}" data-locale-srcset="${screen("mobile", "dark")}" width="780" height="1560">
<source media="(max-width: 760px)" srcset="${localized(screen("mobile", "light"))}" data-locale-srcset="${screen("mobile", "light")}" width="780" height="1560">
<source media="(max-width: 1100px) and (prefers-color-scheme: dark)" srcset="${localized(screen("tablet", "dark"))}" data-locale-srcset="${screen("tablet", "dark")}" width="1640" height="1480">
<source media="(max-width: 1100px)" srcset="${localized(screen("tablet", "light"))}" data-locale-srcset="${screen("tablet", "light")}" width="1640" height="1480">
<source media="(prefers-color-scheme: dark)" srcset="${localized(screen("desktop", "dark"))}" data-locale-srcset="${screen("desktop", "dark")}" width="2400" height="1500">
<img src="${localized(screen("desktop", "light"))}" data-locale-src="${screen("desktop", "light")}" width="2400" height="1500" alt="${copy.previewAlt}" data-i18n-alt="previewAlt" fetchpriority="high">
</picture></div>
<figcaption data-i18n="preview">${copy.preview}</figcaption>
</figure>`
    : "";
  const formGroups = FORM_GROUPS.map(
    (group) =>
      `<div><dt>${text(group.title, "h3")}${text(group.body, "p")}</dt><dd>${group.forms
        .map((form) => `<code>${form}</code>`)
        .join("")}</dd></div>`,
  ).join("\n");
  const chain = DEPLOY_CHAIN.map(
    ([kind, name, step]) =>
      `<li><strong>${kind} <span>${name}</span></strong>${text(step, "p")}</li>`,
  ).join("\n");
  // The API's own root links its own console. The public site's console is
  // takoserver.com's Host, so it is named as that, never as the reader's.
  const consoleAction = !options.consoleOrigin
    ? ""
    : siteAssets
      ? `<p class="more"><a href="${options.consoleOrigin}" data-i18n="consoleSite">${copy.consoleSite}</a></p>`
      : `<div class="actions start"><a class="pill secondary external" href="${options.consoleOrigin}" data-i18n="consoleHost">${copy.consoleHost}</a></div>`;
  const locales = `<link rel="alternate" hreflang="en" href="https://takoserver.com/en/">
<link rel="alternate" hreflang="ja" href="https://takoserver.com/ja/">
<link rel="alternate" hreflang="x-default" href="https://takoserver.com/">`;
  // At the public root a Japanese browser goes to /ja/ before anything loads,
  // so the page and its screenshot are fetched once, in the right language.
  const rootLanguage = siteAssets
    ? `<script>if(location.pathname==="/"&&(navigator.languages??[navigator.language]).map(l=>String(l).toLowerCase().split("-")[0]).find(l=>l==="ja"||l==="en")==="ja")location.replace("/ja/")</script>`
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
<meta name="color-scheme" content="light dark">
${siteAssets ? locales : ""}
${rootLanguage}
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 34 34'%3E%3Crect width='34' height='34' fill='%23b0301f'/%3E%3C/svg%3E">
${siteAssets ? '<link rel="preload" href="/fonts/bricolage-grotesque-latin.woff2" as="font" type="font/woff2" crossorigin>' : ""}
<style>${pageStyles}
${siteAssets ? '@font-face { font-family: "Bricolage Grotesque"; font-style: normal; font-display: swap; font-weight: 200 800; src: url("/fonts/bricolage-grotesque-latin.woff2") format("woff2"); }' : ""}
</style>
</head>
<body>
<a class="skip" href="#main" data-i18n="skip">${copy.skip}</a>
<div class="shell">
<header class="top">
<a class="brand" href="/" aria-label="Takoserver">${takoMark(26)}<span>takoserver</span></a>
<a class="top-link" href="${REPOSITORY}">GitHub</a>
</header>
<main id="main">
<section class="hero" aria-labelledby="headline">
<div class="hero-title">${takoMark(56)}<h1 id="headline">Takoserver</h1></div>
${text("lead", "p", ' class="lead"')}
${text("lede", "p", ' class="lede"')}
<div class="actions"><a class="pill primary external" href="${INSTALL_GUIDE}" data-i18n="install">${copy.install}</a><a class="pill secondary external" href="${REPOSITORY}" data-i18n="source">${copy.source}</a></div>
${preview}
</section>

<section class="block" id="forms" aria-labelledby="forms-title">
${text("formsTitle", "h2", ' id="forms-title"')}
${text("formsBody", "p", ' class="intro"')}
<dl class="forms">
${formGroups}
</dl>
</section>


<section class="block" id="start" aria-labelledby="start-title">
${text("hostTitle", "h2", ' id="start-title"')}
<div class="host">
<ol class="steps">
<li>${text("hostStep1", "p")}<pre>git clone ${REPOSITORY}
cd takoserver
git checkout --detach &lt;reviewed-commit&gt;
bun install --frozen-lockfile</pre></li>
<li>${text("hostStep2", "p")}<span class="chips"><code>TAKOSERVER_PUBLIC_ORIGIN</code><code>TAKOSERVER_TAKOFORM_V2_CONFIG</code><code>TAKOSERVER_TAKOFORM_V2_CURSOR_KEY</code></span></li>
<li>${text("hostStep3", "p")}<pre>bun --no-env-file src/entry-bun.ts</pre></li>
<li>${text("hostStep4", "p")}</li>
</ol>
<aside>
${text("hostNote", "p", ' class="note"')}
<div class="actions start"><a class="pill primary external" href="${INSTALL_GUIDE}" data-i18n="install">${copy.install}</a></div>
<p class="more"><a href="${PREREQUISITES}" data-i18n="prerequisites">${copy.prerequisites}</a><a href="${DOCKER_GUIDE}" data-i18n="docker">${copy.docker}</a><a href="${SECURITY_GUIDE}" data-i18n="security">${copy.security}</a></p>
</aside>
</div>
</section>

<section class="block" id="deploy" aria-labelledby="deploy-title">
${text("deployTitle", "h2", ' id="deploy-title"')}
${text("deployBody", "p", ' class="intro"')}
<div class="deploy">
<ol class="chain">
${chain}
</ol>
<div class="code">
<pre><span class="file">worker.js</span>export default {
  fetch() { return new Response("hello from takoserver\\n"); },
};</pre>
${text("resultLabel", "p")}
<pre>NAME=$(curl -sS "$V2/resources/$ENDPOINT" \\
  -H "authorization: Bearer $KEY" | jq -r .output.hostname)
curl -sS "https://$NAME/"
<span class="out">hello from takoserver</span></pre>
</div>
</div>
<p class="more"><a href="${DEPLOY_STEPS}" data-i18n="deployMore">${copy.deployMore}</a></p>
</section>

<section class="block" id="after" aria-labelledby="after-title">
${text("afterTitle", "h2", ' id="after-title"')}
<div class="after">
<div>${text("consoleTitle", "h3")}${text("consoleBody", "p")}<span class="chips"><code>bun scripts/build-console.ts --api-origin &lt;API origin&gt;</code><code>TAKOSERVER_CONSOLE_ORIGIN</code></span>${consoleAction}</div>
<div>${text("apiTitle", "h3")}${text("apiBody", "p")}<pre>curl -sG "${commandOrigin}/apis/forms.takoform.com/v2/support" \\
  --data-urlencode "form=&lt;Form URL&gt;" \\
  -H "authorization: Bearer $KEY"</pre>
<p class="more"><a href="${V2_REFERENCE}" data-i18n="reference">${copy.reference}</a></p></div>
</div>
</section>
</main>
<footer>
<span class="footer-brand">takoserver</span>
<nav class="footer-links" aria-label="Takoserver">
<a href="${base}/openapi.json" data-i18n="openapi">${copy.openapi}</a>
<a href="${base}/.well-known/takoform/v2" data-i18n="discovery">${copy.discovery}</a>
<a href="${base}/.well-known/takoserver" data-i18n="product">${copy.product}</a>
<a href="${REPOSITORY}" data-i18n="source">${copy.source}</a>
</nav>
</footer>
</div>
<script>
const messages=${JSON.stringify(landingMessages)};
const pathLocale=location.pathname.split("/")[1];
const setLocale=(locale)=>{const lang=locale==="ja"?"ja":"en";document.documentElement.lang=lang;for(const selector of['meta[name="description"]','meta[property="og:description"]','meta[name="twitter:description"]'])document.querySelector(selector).content=messages[lang].description;for(const node of document.querySelectorAll("[data-i18n]"))node.textContent=messages[lang][node.dataset.i18n];for(const node of document.querySelectorAll("[data-i18n-alt]"))node.alt=messages[lang][node.dataset.i18nAlt];for(const node of document.querySelectorAll("[data-locale-srcset]"))node.srcset=node.dataset.localeSrcset.replace("{lang}",lang);for(const node of document.querySelectorAll("[data-locale-src]"))node.src=node.dataset.localeSrc.replace("{lang}",lang)};
const browserLocale=(navigator.languages??[navigator.language]).map(language=>String(language).toLowerCase().split("-")[0]).find(language=>language==="ja"||language==="en")??"en";
setLocale(pathLocale==="ja"||pathLocale==="en"?pathLocale:browserLocale);
${siteAssets ? "" : 'for(const node of document.querySelectorAll("[data-origin]"))node.textContent=location.origin;'}
</script>
</body>
</html>
`;
}

/** The missing-page response, in the same visual system. */
export function notFoundHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>404 | Takoserver</title>
<meta name="robots" content="noindex">
<meta name="color-scheme" content="light dark">
<style>${pageStyles}</style>
</head>
<body class="error">
<main>
<a class="brand" href="/" aria-label="Takoserver">${takoMark(26)}<span>takoserver</span></a>
<p class="code-label">404</p>
<h1>Page not found</h1>
<p>This address does not name a page on takoserver.com.</p>
<a class="pill primary" href="/">Back to takoserver.com</a>
</main>
</body>
</html>
`;
}
