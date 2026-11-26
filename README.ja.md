# Takoserver（日本語ガイド）

English: [README.md](README.md)

Takoserverは、自分のLinuxマシンで動かせるオープンソースのクラウドです。[Takoform](https://takoform.com) の定義（Form）からWorkerとSQLiteデータベース・KV・オブジェクトストレージ・キューをデプロイし、独自ドメインのHTTPSホスト名で公開できます。

このリポジトリが提供するのは、自分のサーバーとドメインで動かすためのソフトウェア本体です。ホスティング済みのアカウントではなく、ホスト運用者自身が所有するマシンと実行基盤（Host-owned supply）でリソースを動かします。

> **現在のクライアント対応状況**
>
> Takoserverは [Takoform Host API v2](https://takoform.com/spec/host-api/v2/) のみを提供します。Host API v2 に対応するTakoformクライアント（OpenTofu providerを含む）はまだリリースされていないため、現在は `curl` または自分で配信するブラウザコンソールからデプロイします。

## Takoform・Takosumiとの関係

- **Takoform（[takoform.com](https://takoform.com)）**: リソースの意味と操作手順を定める仕様です（[Host API v2 仕様](https://takoform.com/spec/host-api/v2/)）。Takoserverはその仕様を実装する独立したHostです。
- **Takoserver（このリポジトリ）**: 運用者自身のマシンや容量を使ってFormを実行するHostです。利用者個人のクラウドアカウント資格情報（BYOC）を持ち込む仕組みではありません。
- **Takosumi（[takosumi.com](https://takosumi.com)）**: アプリの導入や、利用者自身のクラウドアカウント連携（BYOC）を扱う別のOpenTofu管理基盤です。Takoserverは単独で動作し、Takosumiは不要です。

## デプロイできるもの

Bunベースのセルフホストが対応できるTakoform v2のFormは次の16種類です。

- **成果物（Artifacts）**: `WorkerBundle 0.2.0`、`StaticAssetBundle 0.2.0`、`SQLiteMigrationSet 0.4.0`
  - Workerコード・静的ファイル・SQLマイグレーションをURLとSHA-256で固定して保持します。これ単体ではWorkerの実行や公開は行いません。
- **WorkerとHTTPS公開**: `ModuleWorker 0.3.0`、`WorkerVersion 0.5.0`、`WorkerDeployment 0.4.0`、`WorkerCronTrigger 0.3.0`、`WorkerEndpoint 0.3.0`
  - Workerの作成、変更不可の版の管理、最大8バージョン間のトラフィック配分、定期実行、HTTPSホスト名での公開を行います。
- **データ（Data）**: `SQLiteDatabase 0.2.0`、`SQLiteMigrationApplication 0.4.0`、`EdgeKVNamespace 0.2.0`、`ObjectBucket 0.2.0`
  - WorkerからBinding経由で利用するSQLite・KV・オブジェクトストレージと、SQLマイグレーションの適用です。
- **キュー・Actor・Workflow**: `AtLeastOnceQueue 0.2.0`、`QueueConsumer 0.3.0`、`ActorNamespace 0.3.0`、`DurableWorkflow 0.3.0`
  - 少なくとも一度届くキューとその受信、状態を持つActor、永続するWorkflowです。

設定に応じて2つの構成から選ばれます。

1. **成果物と管理APIの構成（Dockerで手軽に試せます）**: 必須の3設定とBunだけで起動し、Host API v2・サインイン・組織・APIキー・成果物Formを提供します。
2. **Worker実行を含む完全構成（Linux x86-64ネイティブ）**: 上記に加えて固定版の `workerd`、GoでビルドするWorkflow execution guard、ワイルドカードTLS証明書とTCP 443を用意すると、Workerの実行・公開と全データBindingが有効になります。

稼働中のHostがどのFormに対応しているかは、次のエンドポイントへ問い合わせて確認できます。

```sh
GET /apis/forms.takoform.com/v2/support?form=<URLエンコードしたForm URL>
```

## どちらから始めるか

| 目的 | 所要時間・前提 | 手順 |
| --- | --- | --- |
| **まずAPI・サインイン・組織・APIキー・成果物Formを試す** | 約5分 / Docker + Compose 2.30以降・`python3`・`curl`・`jq` | 下の[最短で試す（Docker）](#最短で試すdocker) または [Dockerセルフホスト手順（英語）](docs/self-host-docker.md) |
| **自分のLinuxマシンでWorkerをHTTPS公開する** | Linux x86-64（Ubuntu 24.04などglibc 2.38以降）・Bun 1.4.3・Go・ドメインとワイルドカード証明書 | [導入・初回利用手順（英語）](docs/self-host-operations.md#first-install-and-first-use) の手順1〜9 |
| **新しいコードの配信・SQLite/KV/バケット/キュー連携・削除** | Worker公開済み | 同じ手順書の [手順10](docs/self-host-operations.md#10-ship-a-new-version) 〜 [手順13](docs/self-host-operations.md#13-delete-resources) |
| **公開範囲・セキュリティ設計を確認する** | 任意 | [セルフホストのセキュリティ（英語）](docs/self-host-security.md) |
| **設定仕様・全Form制約を確認する** | 任意 | [Takoform v2 設定と仕様（英語）](docs/takoform-v2.md) |

Docker環境からネイティブWorker構成へのインプレース移行はありません。最初からWorkerを動かす場合は、ネイティブ手順で新しいデータディレクトリから始めてください。

## 最短で試す（Docker）

約5分で、ローカルの `127.0.0.1:8787` にTakoserver Hostを起動し、サインイン・組織作成・APIキー発行・Form対応確認まで試せます（このイメージはWorkerを実行しません）。

### 1. ソースを取得してイメージをビルドする

```sh
git clone https://github.com/tako0614/takoserver
cd takoserver
COMMIT=$(git rev-parse origin/main)   # 確認したコミットを固定
git checkout --detach "$COMMIT"
docker build -t takoserver-selfhost:local .
```

### 2. 必須の3設定を作って起動する

リポジトリ外の安全な場所に環境変数ファイルを作成します。

```sh
export TAKOSERVER_ENV_FILE="$HOME/.config/takoserver/docker.env"
install -d -m 0700 "$(dirname "$TAKOSERVER_ENV_FILE")"
python3 - "$TAKOSERVER_ENV_FILE" <<'PY'
import json, os, secrets, sys
config = {
    "documentation": "https://docs.example.com/resources",
    "authenticationDocumentation": "https://docs.example.com/access",
    "sqliteMigrationSet": {"targetKey": "selfhost-artifacts", "heldArtifacts": []},
    "workerBundle": {"targetKey": "selfhost-artifacts", "heldArtifacts": []},
    "staticAssetBundle": {"targetKey": "selfhost-artifacts", "heldArtifacts": []},
}
fd = os.open(sys.argv[1], os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
with os.fdopen(fd, "w") as out:
    out.write("TAKOSERVER_PUBLIC_ORIGIN=https://api.example.com\n")
    out.write("TAKOSERVER_TAKOFORM_V2_CONFIG=" + json.dumps(config, separators=(",", ":")) + "\n")
    out.write("TAKOSERVER_TAKOFORM_V2_CURSOR_KEY=" + secrets.token_urlsafe(32) + "\n")
PY
printf 'TAKOSERVER_ENV_FILE=%s\n' "$TAKOSERVER_ENV_FILE" > .env
docker compose up -d --no-build
```

### 3. 起動確認・サインイン・APIキー発行・Form対応確認

`docker compose ps` で `healthy` になったら、次のコマンドで動作確認と初回サインインを行います。Host API v2は `TAKOSERVER_PUBLIC_ORIGIN` と一致する `Host` ヘッダーが必要です。

```sh
B=http://127.0.0.1:8787
H='Host: api.example.com'

curl --fail --silent --show-error "$B/_takoserver/health/ready"
curl --fail --silent --show-error -H "$H" "$B/.well-known/takoform/v2"

ASSERTION=$(docker compose exec -T \
    -e TAKOSERVER_OPERATOR_KEY=/var/lib/takoserver/operator-key.jwk takoserver \
    bun --no-env-file scripts/operator-key.ts sign-in google operator operator@localhost Operator)
SESSION=$(jq -n --arg assertion "$ASSERTION" \
    '{provider: "google", method: "operator-assertion", $assertion}' |
  curl -sS --fail-with-body -H "$H" -H 'content-type: application/json' \
    --data @- "$B/v1/sessions" | jq -r .sessionToken)
ORG=$(curl -sS --fail-with-body -H "$H" -H "authorization: Bearer $SESSION" \
    -H 'content-type: application/json' --data '{"name":"My organization"}' \
    "$B/v1/organizations" | jq -r .organization.id)
KEY=$(curl -sS --fail-with-body -H "$H" -H "authorization: Bearer $SESSION" \
    -H 'content-type: application/json' \
    --data '{"name":"look around","scopes":["resources:read"],"expiresInSeconds":86400}' \
    "$B/v1/organizations/$ORG/api-keys" | jq -r .secret)

for form in WorkerBundle/0.2.0 ModuleWorker/0.3.0; do
  curl -sS --fail-with-body -G -H "$H" -H "authorization: Bearer $KEY" \
    --data-urlencode "form=https://edge.forms.takoform.com/forms/$form/" \
    "$B/apis/forms.takoform.com/v2/support" | jq -c '{form, supported}'
done
```

`WorkerBundle/0.2.0` が `supported: true`、`ModuleWorker/0.3.0` が `supported: false` と返れば成功です。この先の成果物作成・HTTPSリバースプロキシ・更新・復元手順は [Dockerセルフホスト手順（英語）](docs/self-host-docker.md) に続きます。

## Linux x86-64でWorkerをHTTPS公開する流れ

Workerを実行・公開するには、以下の要素を用意して [導入・初回利用手順（英語）](docs/self-host-operations.md#first-install-and-first-use) に沿って進めます。

- **OS・ランタイム**: Linux x86-64（glibc 2.38以降、Ubuntu 24.04など）、Bun 1.4.3、Goツールチェーン
- **固定バイナリ**: [v2.0.0-rc.1 プレリリース](https://github.com/tako0614/takoserver/releases/tag/v2.0.0-rc.1) に添付された固定版 `workerd`（`SHA256SUMS` で検証）と、チェックアウトからビルドする `workflow-execution-guard`
- **HTTPSとDNS**: Worker用のワイルドカードDNS名と証明書（例: `*.apps.example.com`、TCP 443をHostが直接待機）および管理API用のCaddyなどのHTTPSフロントエンド（別ポート、例: `api.example.com:8443`）

手順の全体像:

1. **Hostの構築（手順1〜5）**: [前提条件](docs/self-host-operations.md#1-prerequisites) → [データディレクトリ](docs/self-host-operations.md#2-data-root) → [設定とsystemd](docs/self-host-operations.md#3-configuration) → [HTTPSとTCP 443](docs/self-host-operations.md#4-https-and-tcp-443) → [初回起動とサインイン](docs/self-host-operations.md#5-first-boot-and-operator-sign-in)（任意で [コンソール](docs/self-host-operations.md#the-console-optional) をビルドして配信）
2. **最初のWorker公開（手順6〜9）**: [成果物の配置](docs/self-host-operations.md#6-seed-held-artifacts) → [Form対応確認](docs/self-host-operations.md#7-check-form-support) → [5つのリソース作成](docs/self-host-operations.md#8-create-and-serve-a-worker)（`ModuleWorker` → `WorkerBundle` → `WorkerVersion` → `WorkerDeployment` → `WorkerEndpoint`）→ [疎通確認](docs/self-host-operations.md#9-verify)
3. **更新・データ連携・削除（手順10〜13）**: [新しい版の配信と切り戻し](docs/self-host-operations.md#10-ship-a-new-version) · [SQLite連携](docs/self-host-operations.md#11-bind-a-sqlite-database) · [KV・バケット・キュー連携](docs/self-host-operations.md#12-bind-kv-a-bucket-and-a-queue) · [参照順の削除](docs/self-host-operations.md#13-delete-resources)
4. **継続運用**: [監視](docs/self-host-operations.md#monitoring)（`GET /_takoserver/health/ready`）· [コールドスナップショット](docs/self-host-operations.md#cold-snapshot) · [更新とコードロールバック](docs/self-host-operations.md#update-and-code-rollback)

## 開発・検証とライセンス

- 開発者向けの完全検証ゲート: `bun run check`（読み取り専用）
- フォーマット修正: `bun run fmt`
- 英語版の全リファレンス: [README.md](README.md)
- セキュリティ報告: [SECURITY.md](SECURITY.md)
- ライセンス: [GNU Affero General Public License v3.0](LICENSE)
