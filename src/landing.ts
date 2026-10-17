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
  /**
   * The Host's public origin, when a Host serves the page. Host API v2 answers
   * only there, so the page names it rather than the origin it was read from.
   */
  readonly hostOrigin?: string;
}

const REPOSITORY = "https://github.com/tako0614/takoserver";
const GUIDE = `${REPOSITORY}/blob/main/docs/self-host-operations.md`;
const INSTALL_GUIDE = `${GUIDE}#first-install-and-first-use`;
const DEPLOY_STEPS = `${GUIDE}#6-seed-held-artifacts`;
const DOCKER_GUIDE = `${REPOSITORY}/blob/main/docs/self-host-docker.md`;
const CONSOLE_SETUP = `${GUIDE}#the-console-optional`;
const SHIP_STEPS = `${GUIDE}#10-ship-a-new-version`;
const WORKER_STEPS = `${GUIDE}#8-create-and-serve-a-worker`;
const SQLITE_STEPS = `${GUIDE}#11-bind-a-sqlite-database`;
const DATA_STEPS = `${GUIDE}#12-bind-kv-a-bucket-and-a-queue`;
const MONITORING = `${GUIDE}#monitoring`;
const BACKUP = `${GUIDE}#cold-snapshot`;
const UPDATE = `${GUIDE}#update-and-code-rollback`;
const SECURITY_GUIDE = `${REPOSITORY}/blob/main/docs/self-host-security.md`;
const V2_REFERENCE = `${REPOSITORY}/blob/main/docs/takoform-v2.md`;
const PREREQUISITES = `${GUIDE}#1-prerequisites`;
/** The release that attaches the pinned workerd; 1.0.0, marked Latest, has none. */
const WORKERD_RELEASE = `${REPOSITORY}/releases/tag/v2.0.0-rc.1`;
const TAKOFORM = "https://takoform.com";

const landingMessages = {
  en: {
    description:
      "Takoserver is an open-source cloud you host yourself. Deploy Workers and their SQLite, KV, object storage and queues to your own machine from Takoform definitions.",
    skip: "Skip to content",
    lead: "Deploy Takoform.\nRun your own cloud.",
    lede: "Takoserver is an open-source cloud that runs on your own Linux machine. Deploy Workers and their SQLite, KV, object storage and queues from Takoform definitions, and operate them yourself.",
    install: "Read the install guide",
    source: "Source code",
    preview: "Resources in the Takoserver Console · public sample data",
    previewAlt:
      "The Takoserver Console's Resources page: a Worker named hello with its version, deployment and endpoint all Ready, its WorkerBundle, and a SQLite database, in public sample data",
    formsTitle: "What you can deploy",
    formsBody:
      "Takoform describes each kind of resource, such as a Worker, a database or a queue, as a Form: a definition its publisher serves at a versioned URL, so the resource means the same on every Host that supports it. Takoserver runs these Forms.",
    formsNeeds:
      "Artifacts need only Bun and a short block in the Host's settings. Everything else needs the Worker runtime of step 2 below, and publishing at a hostname also needs step 3. A running Host answers, for each Form URL, whether it serves that Form.",
    takoform: "About Takoform",
    artifactsTitle: "Artifacts",
    artifactsBody: "Worker code, static files and SQL migrations, pinned by URL and SHA-256.",
    workersTitle: "Workers and HTTPS",
    workersBody:
      "Create a Worker, cut versions, choose which one serves, run it on a schedule and publish it at its own HTTPS hostname.",
    dataTitle: "Data",
    dataBody:
      "SQLite databases, KV namespaces and object buckets that a Worker reaches through bindings.",
    asyncTitle: "Queues, actors and workflows",
    asyncBody:
      "At-least-once queues and their consumers, actors that keep state, and durable workflows.",
    hostTitle: "Run your own Host",
    hostStep1:
      "Use a Linux x86-64 machine with Bun. Check out a reviewed commit of main, which the install guide describes, and install its locked dependencies.",
    hostStep2:
      "Add the Worker runtime: the pinned workerd attached to the 2.0.0-rc.1 pre-release, checked against its SHA256SUMS, and the Workflow execution guard, a small Go program built from the same checkout. That workerd needs glibc 2.38 or newer, such as Ubuntu 24.04.",
    hostStep3:
      "Give it HTTPS. For Workers, get a wildcard DNS name and certificate, such as *.apps.example.com; a wildcard certificate is issued through a DNS challenge, which needs your DNS provider's API. The Host serves Workers on port 443 itself, so put the API behind a front end such as Caddy on another port, such as 8443.",
    hostStep4:
      "Write its settings and start it. Three are always required; the Worker runtime and HTTPS add their own (step 3 of the install guide), and a partial Worker setup offers no Worker Forms. Without an identity provider, the first boot prints a single-use operator sign-in assertion.",
    hostNote:
      "Without the Worker runtime and port 443, the Host still keeps artifacts and serves the API, sign-in, organizations and keys. To try that much quickly, use Docker.",
    releases: "Takoserver 2.0.0-rc.1 (pre-release)",
    prerequisites: "Prerequisites",
    docker: "Try it in Docker",
    security: "Self-host security",
    deployTitle: "Deploy one Worker",
    deployBody:
      "Five Resources, created in this order with curl over Host API v2. Each create is accepted as an Operation that you poll until it succeeds. $V2, $F, $ORG and $KEY come from step 5 of the install guide, and step 8 runs the whole chain with a small create function. No released Takoform client speaks Host API v2 yet, so today you deploy with requests like these or in the console.",
    createLabel:
      "Each create is one POST. Sent again with the same idempotency-key within 24 hours, it returns the same Operation instead of a second Worker.",
    workerStep: "is the Worker itself. Its versions, deployment and endpoint refer to it.",
    bundleStep:
      "names worker.js by the URL and SHA-256 of a manifest that lists it. Publish the manifest and its files over public HTTPS and the Host fetches them, or seed them onto the Host with scripts/selfhost-artifact.ts, which prints both values.",
    versionStep: "pairs that bundle with its fetch handler.",
    deploymentStep: "chooses which version serves: here one version, weight 10000.",
    endpointStep: "publishes the Worker at an HTTPS hostname.",
    resultLabel: "Then request it, with the UID the Endpoint's create returned in $ENDPOINT:",
    deployMore: "Steps 6 to 9 in the guide",
    afterTitle: "After you deploy",
    consoleTitle: "Use the console",
    consoleBody:
      "The console can also create these Resources in the browser. Choose a Form and it fills in the smallest spec this Host accepts; you can pick each Resource it refers to by name, and nothing is sent until you choose Create. It shows each Worker with the address it is served at and whether it is Ready. It is a static app built from this repository and served on its own origin next to the API.",
    consoleSetup: "Set up the console (install guide, step 5)",
    consoleHost: "Open this Host's console",
    hereTitle: "This is a Takoserver Host",
    hereBody:
      "People with an organization on this Host manage its Workers and data in the console, or over Host API v2 at this address:",
    hereNoConsole: "This Host serves no console yet.",
    shipTitle: "Ship a new version",
    shipBody:
      "Code never changes in place. Create the new code and a version for it, then point the Deployment at that version; the Endpoint keeps its address. In the console, once the new version is Ready, choose “Serve this version” on its page; it prepares this update, which is sent when you choose Update. To go back, serve the earlier version again the same way.",
    shipBundle:
      "holds the new worker.js, by the URL and SHA-256 of its manifest. Published over public HTTPS from another machine, it needs no restart; seeded onto the Host, it needs a restart, which stops every Worker until the Host is back.",
    shipVersion: "pairs the new WorkerBundle with its fetch handler.",
    shipDeploy:
      "is updated to serve hello-version-v2 at weight 10000. The update names the generation it read, so a change made in between is not overwritten.",
    shipMore: "Step 10 of the install guide",
    step6: "Step 6 of the install guide",
    step8: "Step 8 of the install guide",
    sqliteStep: "SQLite: step 11 of the install guide",
    dataStep: "KV and buckets: step 12 of the install guide",
    queueStep: "Queues: step 12 of the install guide",
    keepTitle: "Keep it running",
    keepBody:
      "Poll the Host's readiness probe, GET /_takoserver/health/ready on its own port: 503, or no answer, means it cannot serve; degraded: true means it still serves but something needs you: a Worker that is not ready, work waiting too long, or a background job that keeps failing. To back up, stop the Host and copy its whole data root and /etc/takoserver, which holds its cursor key and the config that grants its seeded code. To update, check out a newer reviewed commit beside the running one and switch to it, keeping the previous checkout and a backup.",
    monitoring: "Monitoring",
    backup: "Cold snapshot",
    update: "Update",
    reference: "Host API v2 reference",
    openapi: "OpenAPI description",
    discovery: "Takoform Host discovery",
    product: "Product discovery",
  },
  ja: {
    description:
      "Takoserverは、自分でホストするオープンソースのクラウドです。WorkerとそのSQLite・KV・オブジェクトストレージ・キューを、Takoformの定義から自分のマシンへデプロイできます。",
    skip: "本文へ移動",
    lead: "Takoformを、\n自分のクラウドへ。",
    lede: "Takoserverは、自分のLinuxマシンで動かすオープンソースのクラウドです。WorkerとそのSQLite・KV・オブジェクトストレージ・キューを、Takoformの定義からデプロイして運用できます。",
    install: "導入手順を読む（英語）",
    source: "ソースコード",
    preview: "Takoserver Consoleのリソース一覧（公開用サンプルデータ）",
    previewAlt:
      "Takoserver Consoleのリソース一覧。helloというWorkerとその版・配信・公開先が稼働中で、WorkerBundleとSQLiteデータベースも並んでいます（公開用サンプルデータ）",
    formsTitle: "デプロイできるもの",
    formsBody:
      "Takoformでは、Worker・データベース・キューといったリソースの種類ごとの定義をFormと呼び、公開元がバージョン付きのURLで公開します。対応するHostであれば、どこでも同じ意味のリソースになります。Takoserverは次のFormを動かせます。",
    formsNeeds:
      "成果物は、Bunと設定への短い記述の追加だけで使えます。それ以外には下の手順2のWorker実行環境が必要で、ホスト名で公開するには手順3も必要です。動いているHostには、Form URLごとに対応しているかを問い合わせられます。",
    takoform: "Takoformについて",
    artifactsTitle: "成果物",
    artifactsBody:
      "Workerのコード・静的ファイル・SQLのマイグレーションを、URLとSHA-256で固定して保持します。",
    workersTitle: "Workerと公開",
    workersBody:
      "Workerを作り、版を作り、配信する版を決め、定期実行し、専用のHTTPSホスト名で公開します。",
    dataTitle: "データ",
    dataBody: "WorkerがBindingで使うSQLiteデータベース、KV、オブジェクトストレージです。",
    asyncTitle: "キュー・Actor・Workflow",
    asyncBody: "少なくとも一度届くキューとその受信、状態を持つActor、永続するWorkflowです。",
    hostTitle: "自分のHostを動かす",
    hostStep1:
      "Linux x86-64のマシンとBunを用意します。導入手順書が説明しているmainから、レビュー済みのコミットを取り出し、ロックファイルで固定された依存関係をインストールします。",
    hostStep2:
      "Workerの実行環境を加えます。プレリリース2.0.0-rc.1に添付された固定版のworkerdをSHA256SUMSで確認して置き、Workflow execution guard（同じチェックアウトからGoでビルドする小さなプログラム）を用意します。このworkerdには、Ubuntu 24.04などglibc 2.38以降の環境が必要です。",
    hostStep3:
      "HTTPSを用意します。Worker用に、*.apps.example.comのようなワイルドカードのDNS名と証明書を用意します。ワイルドカード証明書はDNSチャレンジで発行するため、DNSプロバイダーのAPIが必要です。443番はHost自身がWorkerの配信に使うので、APIはCaddyなどのフロントエンドの背後に、8443番など別のポートで置きます。",
    hostStep4:
      "設定を書いて起動します。常に必要な設定は3つで、Worker実行環境とHTTPSにはそれぞれ追加の設定があります（導入手順書の手順3）。Worker実行環境の設定が一部でも欠けると、Worker関連のFormは提供されません。IDプロバイダーが未設定なら、初回起動時に、一度だけ使える運営者のサインイン用アサーションが表示されます。",
    hostNote:
      "Worker実行環境と443番がなくても、Hostは成果物を保持し、API・サインイン・組織・APIキーを提供します。そこまでを手早く試すならDockerを使えます。",
    releases: "Takoserver 2.0.0-rc.1（プレリリース）",
    prerequisites: "前提条件",
    docker: "Dockerで試す",
    security: "セルフホストのセキュリティ",
    deployTitle: "Workerを1つデプロイする",
    deployBody:
      "5つのリソースを、この順にcurlとHost API v2で作成します。作成はOperationとして受け付けられ、成功するまで状態を確認します。$V2・$F・$ORG・$KEYは導入手順書の手順5で用意します。手順書では、小さなcreate関数でこの流れ全体を実行します。Host API v2に対応したTakoformのクライアントはまだリリースされていないため、現在はこのようなリクエストかコンソールでデプロイします。",
    createLabel:
      "作成は1回のPOSTです。24時間以内に同じidempotency-keyで送り直すと、2つ目のWorkerは作らず同じOperationを返します。",
    workerStep: "Workerそのものです。版・配信・公開先はこれを参照します。",
    bundleStep:
      "worker.jsを、それを列挙したmanifestのURLとSHA-256で指定します。manifestとファイルを公開HTTPSに置けばHostが取得します。scripts/selfhost-artifact.tsでHostに保持させることもでき、このコマンドが両方の値を出力します。",
    versionStep: "そのWorkerBundleとfetchハンドラーを組み合わせた版です。",
    deploymentStep: "どの版を配信するかを決めます。ここでは1つの版を重み10000で配信します。",
    endpointStep: "WorkerをHTTPSのホスト名で公開します。",
    resultLabel: "公開したら、Endpointの作成で返ったUIDを$ENDPOINTに入れてリクエストします。",
    deployMore: "手順書（英語）の手順6〜9",
    afterTitle: "デプロイしたあと",
    consoleTitle: "コンソールを使う",
    consoleBody:
      "コンソールでも、同じリソースをブラウザーから作成できます。Formを選ぶとこのHostが受け付ける最小の設定が入り、設定が参照するリソースは名前で選べます。「作成する」を押すまで、何も送信されません。各Workerの公開先と稼働中かどうかも表示されます。コンソールはこのリポジトリからビルドする静的アプリで、APIと並ぶ別のオリジンで配信します。",
    consoleSetup: "コンソールを用意する（英語の導入手順書の手順5）",
    consoleHost: "このHostのコンソールを開く",
    hereTitle: "ここはTakoserverのHostです",
    hereBody:
      "このHostに組織を持つ人は、そのWorkerとデータを、コンソールか次のアドレスのHost API v2で管理します。",
    hereNoConsole: "このHostにはまだコンソールがありません。",
    shipTitle: "新しい版を出す",
    shipBody:
      "動いているコードは書き換えられません。新しいコードと版を作り、Deploymentをその版に切り替えます。Endpointの公開先はそのままです。コンソールでは、新しい版が稼働中になったら、そのページで「この版を配信する」を押すとこの更新が用意され、「更新する」を押すと送信されます。元に戻すときは、前の版を同じ方法で配信します。",
    shipBundle:
      "新しいworker.jsを、そのmanifestのURLとSHA-256で指定します。別のマシンの公開HTTPSに置けば再起動は不要です。Hostに保持させる場合は再起動が必要で、その間はすべてのWorkerが止まります。",
    shipVersion: "新しいWorkerBundleとfetchハンドラーを組み合わせた版です。",
    shipDeploy:
      "hello-version-v2を重み10000で配信するよう更新します。更新は読み取った世代を指定するので、その間に入った別の変更を上書きしません。",
    shipMore: "手順書（英語）の手順10",
    step6: "手順書（英語）の手順6",
    step8: "手順書（英語）の手順8",
    sqliteStep: "SQLite：手順書（英語）の手順11",
    dataStep: "KV・バケット：手順書（英語）の手順12",
    queueStep: "キュー：手順書（英語）の手順12",
    keepTitle: "動かし続ける",
    keepBody:
      "準備状態は、Host自身のポートで GET /_takoserver/health/ready を定期的に確認します。503か応答がなければサービスを提供できず、degraded: true ならサービスは続いていますが、準備できていないWorker、長く待っている作業、失敗が続くバックグラウンド処理など、対応が必要なものがあります。バックアップするには、Hostを停止して、データルート全体と /etc/takoserver（カーソルキーと、保持させたコードを許可する設定があります）をコピーします。更新するには、レビュー済みの新しいコミットを今のチェックアウトの横に用意して切り替えます。前のチェックアウトとバックアップは残しておきます。",
    monitoring: "監視（英語）",
    backup: "コールドスナップショット（英語）",
    update: "更新（英語）",
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
    steps: [[DEPLOY_STEPS, "step6"]],
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
    steps: [[WORKER_STEPS, "step8"]],
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
    steps: [
      [SQLITE_STEPS, "sqliteStep"],
      [DATA_STEPS, "dataStep"],
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
    steps: [[DATA_STEPS, "queueStep"]],
  },
] as const;

/** The Worker chain of the install guide, in the order it is created. */
const DEPLOY_CHAIN = [
  ["ModuleWorker 0.3.0", "hello", "workerStep"],
  ["WorkerBundle 0.2.0", "hello-bundle-v1", "bundleStep"],
  ["WorkerVersion 0.5.0", "hello-version-v1", "versionStep"],
  ["WorkerDeployment 0.4.0", "hello-deployment", "deploymentStep"],
  ["WorkerEndpoint 0.3.0", "hello-endpoint", "endpointStep"],
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

.here { margin: 40px auto 0; max-width: 760px; padding: 28px 32px; text-align: left; background: var(--surface-2); border: 1px solid var(--line-1); border-radius: 18px; }
.here h2 { font-size: clamp(22px, 2.4vw, 28px); }
.here p { margin: 12px 0 0; color: var(--ink-2); font-size: 15px; }
.here .address { overflow-wrap: break-word; color: var(--ink-1); }
.here .actions { margin-top: 20px; }

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
.forms dt .more { margin-top: 12px; }
.forms dt .more a { white-space: normal; }
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
.steps .more { margin-top: 8px; }
.chips { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
.chips code { padding: 4px 10px; border: 1px solid var(--line-1); border-radius: 999px; background: var(--surface-2); font: 12.5px/1.6 var(--mono); overflow-wrap: anywhere; }
.note { margin: 24px 0 0; max-width: 44em; color: var(--ink-2); font-size: 14px; }

.after { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 48px; margin-top: 40px; }
.after > div { min-width: 0; padding-top: 24px; border-top: 1px solid var(--line-1); }
.after p { margin: 12px 0 0; color: var(--ink-2); font-size: 15px; }
.after .chips code { font-size: 12px; border-radius: 8px; }
.after pre { margin-top: 16px; }
.after .chain { margin-top: 16px; }
.after .chain p { margin: 2px 0 0; font-size: 14px; }
.actions.start { justify-content: flex-start; }
.after .actions { margin-top: 20px; }
.after .keep { margin-top: 32px; padding-top: 24px; border-top: 1px solid var(--line-1); }

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
/* Below desktop width the code beside each list would scroll sideways, so the columns stack. */
@media (max-width: 1216px) { .deploy, .host, .after { grid-template-columns: minmax(0, 1fr); gap: 24px; } }
@media (max-width: 760px) {
  .shell { width: calc(100% - 32px); }
  .top { height: 72px; }
  .hero { padding: 48px 0 32px; }
  .hero-title { gap: 12px; }
  .here { margin-top: 28px; padding: 22px 20px; }
  .hero-title svg { width: 36px; height: 36px; }
  h1 { font-size: clamp(34px, 8.7vw, 56px); }
  .lead { font-size: 19px; margin-top: 20px; }
  .actions { margin-top: 28px; gap: 8px; }
  .pill { min-height: 44px; padding: 10px 18px; font-size: 13px; }
  .preview { margin-top: 40px; }
  .frame { padding: 6px; border-radius: 16px; }
  .frame picture { border-radius: 10px; }
  /* The 390px phone capture plus padding and two 1px borders: never enlarged. */
  .preview .frame { max-width: 406px; margin-inline: auto; }
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
  const base = options.apiOrigin ?? options.hostOrigin ?? "";
  // A Host's own root is that Host's page: a shared link names the Host, and
  // search leaves it out rather than list a copy of takoserver.com's page.
  const pageUrl = options.hostOrigin
    ? `${options.hostOrigin}/`
    : `https://takoserver.com/${locale === "ja" ? "ja/" : ""}`;
  // A Host names its own public origin; without one, the page fills in the
  // origin it was read from.
  const hostAddress = options.hostOrigin ?? "<span data-origin>$HOST</span>";
  // The public site ships its font and the Console screenshots as files; the
  // API answering its own root stays a single self-contained response.
  const siteAssets = options.apiOrigin !== null;
  // Commands target the reader's own Host. On the public site that is $HOST;
  // the API's own root fills in the origin it was read from.
  // On the public site the request uses the guide's $V2; a Host's own root
  // page fills in the origin it was read from.
  const shipTarget = siteAssets
    ? "$V2/resources"
    : `${hostAddress}/apis/forms.takoform.com/v2/resources`;
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
      `<div><dt>${text(group.title, "h3")}${text(group.body, "p")}<p class="more">${group.steps
        .map(([href, key]) => `<a href="${href}" data-i18n="${key}">${copy[key]}</a>`)
        .join("")}</p></dt><dd>${group.forms
        .map((form) => `<code>${form}</code>`)
        .join("")}</dd></div>`,
  ).join("\n");
  const chain = DEPLOY_CHAIN.map(
    ([kind, name, step]) =>
      `<li><strong>${kind} <span>${name}</span></strong>${text(step, "p")}</li>`,
  ).join("\n");
  // The API's own root links its own console. The public site's console is
  // takoserver.com's Host, so it is named as that, never as the reader's.
  // Only a Host's own root links its console; the public site describes the
  // reader's own Host, never takoserver.com's.
  // A Host's own root first says where the reader is and how to manage it;
  // the public site has no such place to point at.
  const here = siteAssets
    ? ""
    : `<section class="here" aria-labelledby="here-title">
${text("hereTitle", "h2", ' id="here-title"')}
${text("hereBody", "p")}
<p class="address"><code>${hostAddress}/<wbr>apis/<wbr>forms.takoform.com/<wbr>v2</code></p>
${
  options.consoleOrigin
    ? `<div class="actions start"><a class="pill primary external" href="${options.consoleOrigin}" data-i18n="consoleHost">${copy.consoleHost}</a></div>`
    : `${text("hereNoConsole", "p")}<p class="more"><a href="${CONSOLE_SETUP}" data-i18n="consoleSetup">${copy.consoleSetup}</a></p>`
}
<p class="more"><a href="${base}/.well-known/takoform/v2" data-i18n="discovery">${copy.discovery}</a><a href="${base}/openapi.json" data-i18n="openapi">${copy.openapi}</a></p>
</section>`;
  const consoleAction =
    options.consoleOrigin && !siteAssets
      ? `<div class="actions start"><a class="pill secondary external" href="${options.consoleOrigin}" data-i18n="consoleHost">${copy.consoleHost}</a></div>`
      : "";
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
<meta property="og:url" content="${pageUrl}">
<meta property="og:image" content="https://takoserver.com/og.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
${siteAssets ? `<link rel="canonical" href="${pageUrl}">` : '<meta name="robots" content="noindex">'}
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
${here}
${text("lead", "p", ' class="lead"')}
${text("lede", "p", ' class="lede"')}
<div class="actions"><a class="pill primary external" href="${INSTALL_GUIDE}" data-i18n="install">${copy.install}</a><a class="pill secondary external" href="${REPOSITORY}" data-i18n="source">${copy.source}</a></div>
${preview}
</section>

<section class="block" id="forms" aria-labelledby="forms-title">
${text("formsTitle", "h2", ' id="forms-title"')}
${text("formsBody", "p", ' class="intro"')}
${text("formsNeeds", "p", ' class="intro"')}
<dl class="forms">
${formGroups}
</dl>
<p class="more"><a href="${TAKOFORM}" data-i18n="takoform">${copy.takoform}</a></p>
</section>


<section class="block" id="start" aria-labelledby="start-title">
${text("hostTitle", "h2", ' id="start-title"')}
<div class="host">
<ol class="steps">
<li>${text("hostStep1", "p")}<pre>git clone ${REPOSITORY}
cd takoserver
COMMIT=$(git rev-parse origin/main)
git checkout --detach "$COMMIT"
bun install --frozen-lockfile</pre></li>
<li>${text("hostStep2", "p")}<p class="more"><a href="${WORKERD_RELEASE}" data-i18n="releases">${copy.releases}</a></p></li>
<li>${text("hostStep3", "p")}</li>
<li>${text("hostStep4", "p")}<span class="chips"><code>TAKOSERVER_PUBLIC_ORIGIN</code><code>TAKOSERVER_TAKOFORM_V2_CONFIG</code><code>TAKOSERVER_TAKOFORM_V2_CURSOR_KEY</code></span><pre>bun --no-env-file src/entry-bun.ts</pre></li>
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
${text("createLabel", "p")}
<pre>jq -n --arg form "$F/ModuleWorker/0.3.0/" --arg space "$ORG" \\
  '{$form, $space, name: "hello", spec: {}}' |
curl -sS "$V2/resources" --data @- \\
  -H "authorization: Bearer $KEY" \\
  -H "content-type: application/json" \\
  -H "idempotency-key: takoserver-first-use-hello"</pre>
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
<div>${text("consoleTitle", "h3")}${text("consoleBody", "p")}${consoleAction}
<p class="more"><a href="${CONSOLE_SETUP}" data-i18n="consoleSetup">${copy.consoleSetup}</a></p>
<div class="keep">${text("keepTitle", "h3")}${text("keepBody", "p")}
<p class="more"><a href="${MONITORING}" data-i18n="monitoring">${copy.monitoring}</a><a href="${BACKUP}" data-i18n="backup">${copy.backup}</a><a href="${UPDATE}" data-i18n="update">${copy.update}</a></p></div></div>
<div>${text("shipTitle", "h3")}${text("shipBody", "p")}
<ol class="chain">
<li><strong>WorkerBundle 0.2.0 <span>hello-bundle-v2</span></strong>${text("shipBundle", "p")}</li>
<li><strong>WorkerVersion 0.5.0 <span>hello-version-v2</span></strong>${text("shipVersion", "p")}</li>
<li><strong>WorkerDeployment 0.4.0 <span>hello-deployment</span></strong>${text("shipDeploy", "p")}</li>
</ol>
<pre>PUT ${shipTarget}/&lt;Deployment UID&gt;
idempotency-key: &lt;a new key&gt;
takoform-expected-generation: &lt;the generation it read&gt;

{"spec": {
  "worker": {"resourceUid": "&lt;hello UID&gt;"},
  "versions": [{
    "workerVersion": {"resourceUid": "&lt;hello-version-v2 UID&gt;"},
    "weight": 10000}]}}</pre>
<p class="more"><a href="${SHIP_STEPS}" data-i18n="shipMore">${copy.shipMore}</a><a href="${V2_REFERENCE}" data-i18n="reference">${copy.reference}</a></p></div>
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

/**
 * The missing-page response, in the same visual system: one page for every
 * missing address. It reads in the language the rest of the site would:
 * Japanese under /ja/, English under /en/, and otherwise the browser's first
 * choice of the two.
 */
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
<h1 data-404="title">Page not found</h1>
<p data-404="body">This address does not name a page on takoserver.com.</p>
<a class="pill primary" href="/" data-404="back">Back to takoserver.com</a>
</main>
<script>
const ja={title:"ページが見つかりません",body:"このアドレスにtakoserver.comのページはありません。",back:"takoserver.comに戻る"};
const first=location.pathname.split("/")[1];
const browser=(navigator.languages??[navigator.language]).map(l=>String(l).toLowerCase().split("-")[0]).find(l=>l==="ja"||l==="en");
if(first==="ja"||(first!=="en"&&browser==="ja")){document.documentElement.lang="ja";for(const node of document.querySelectorAll("[data-404]"))node.textContent=ja[node.dataset["404"]];for(const link of document.querySelectorAll('[data-404="back"],.brand'))link.href="/ja/";}
</script>
</body>
</html>
`;
}
