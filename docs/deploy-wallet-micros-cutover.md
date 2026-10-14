# 既存integration D1のUSD-micros cutover

この経路は既存のstaging専用で、production・fresh generation・0088→0092の適用資格を広げない。D1/R2を削除・作り直さず、0093分類準備、証拠投入、0094不可逆変換を別phaseとして実行する。0095以後は独立したsuffix qualificationが必要で、この経路から自動適用しない。

## 入口と資格

通常の`bun run deploy -- takoserver-d1-schema --status|--apply --environment=integration --commit=<exact SHA> --through-migration=0093|0094`を使う。operator-owned 0600 declarationを`TAKOSERVER_D1_MONEY_CUTOVER_DECLARATION_PATH`で指定する。declarationは絶対パス、正のstaging identity、phase、maintenance/source、保護された起源・writer inventory・backup・分類・review・custodyの各path/digestを束縛する。schema waveのowner adapterがnative readbackを行い、停止booleanを入力として採用しない。

新経路はproduction target設定やproduction D1を読まない。既存generationの正常終了記録とpost-statusの正のstaging metadataを独立reviewしたcertificate、固定0001–0092 digest、native D1 UUID/nameとR2 nameの一致を求める。名前だけでは許可しない。秘密値・snapshot内容・provider生出力をログやPRへ出さない。

## 順序

1. 専用`pre-wallet-usd-micros-quiesced` targetを、レビュー済みsourceから通常のWorker authority-cutoverでpublishする。全HTTP受付を503にし、scheduledのwallet/Stripe/reseller処理を止める。別のclean checkoutの正確なcommitから同じartifactをdry-run再buildし、正規authority-cutoverの保護terminal receiptのartifact/source/native Version/deploymentへ束縛する。source・native module bytes・binding closure・100% deployment・maintenance responseを前後で照合する。private componentのあるmanaged profileは検証済みのimmutable source inventoryとnative revisionを束縛し、金銭テーブルwriterを含まないことを独立reviewする。private backendを持たないstandalone profileは、public source inventoryとexact native binding closureからその不在を検証し、private componentやGit archiveを捏造しない。これを全WfP処理の停止証明とは呼ばない。
2. `freeze` statusで既存D1のfull exportをowned 0600 fileへ保護保存する。NULを正規化しlocal SQLiteへ全dumpを復元、schema/lineage/FK・table counts・typed byte-safe row digest・通貨前像をnative D1と照合する。statusはD1に書き込まないがbackup fileを作成できる。
3. statusが返す具体的なreview bindingに対して独立reviewを行い、保護された証拠を固定する。`freeze` applyで全監査金銭テーブルのINSERT/UPDATE/DELETEを閉じる**永続trigger**を原子的に入れる。新規受付停止とこのDB fenceを組み合わせ、遅れて到着する旧writerのDMLを拒否する。D1内のpendingゼロは外部Stripe checkout・in-flight webhook・provider action・全WfP invocationの完了を証明しない。外部決済の未解決状態はoperatorの別証拠で確認し、不明なら停止を維持する。
4. `prepare`（through0093）をstatus→review→applyし、監査済み0093だけを適用する。92→94を一括で飛び越えない。
5. `classify`でnon-purchased lotのexact key/kind/original amount/expiryとreview済み根拠を保護manifestに束縛する。全件一致を検証し、専用原子的importだけで分類証拠を投入する。purchasedを勝手にFreeへ変えるなどの推測はしない。
6. `convert` status→独立review→apply。pending holds/allocations/usage/settlements/Stripe/old usage group、実INTEGERと安全範囲、ledger/lot/allocation保存則、分類全件一致を確認する。old fence削除、**監査済み0094そのままのSQL**、migration ledger insert、新fence設置を単一sealed D1 file `/import`に収める。別呼出しで無防備な間を作らない。
7. exact94+fence、USD-micros policy、row/aggregate前像との保存則、foreign keys、classification/historyをreadbackしterminal custodyを記録する。新USD-micros Workerはこの明示的なfenced read-side schemaを検証してpublishできるが、DB fenceは金銭writeを拒否し続ける。
8. latest mainの正規authority-cutover・source/native module/closure/100% deployment・healthを確認し、`resume` status→review→applyでfenceを外す。旧cents artifactを自動再開しない。その後wallet hold/capture/release/expiry、micros wire、実usage fold、replayとrefusalをstagingで再試験する。

全phaseはbinding-specific独立reviewとsame-D1 publication leaseを必要とする。statusのready表示、marker、source inventory、手入力の金額だけを適用許可にしない。SQL本体は変更せず、包むimport・財務fence・shapeを固定する。未知extra table/trigger、部分lineage、origin/private/source/module mismatchは拒否する。

## 失敗・復旧

D1 mutation前と後を区別し、dispatchをno-overwriteでfsyncしてから一度だけ送る。ACK不明・readback不明は同じDBのGET/SELECT照合だけを行い、blind再importしない。完成schemaに見えてもcustody・金額前像・保存則が一致するまで成功としない。

0094前の`abandon`は、convertのdispatchが無く、exact92/93+fence、金銭前像不変、外部cash pendingゼロ、maintenance維持、独立reviewがある場合にのみ、所有fenceを原子的に外す。Hostは503のまま保持する。旧承認artifactへの再公開は別の正規authority復旧操作で資格を満たす必要があり、現mainの94 guardを回避しない。

0094後のdown migrationやcents binaryへのrollbackは無い。保護backup・SQL内immutable preimages/aggregates・custodyからforward repairする。DBを削除・再作成しない。file import原子性はpinned Wranglerの`/import`実装、local D1/SQLite失敗注入、staging複製での途中失敗と成功の検証を束縛してから本targetへ適用する。複製DBを既存targetの代替にしない。

## 実証の境界

standalone HostのoperatorIdentityは検証済み公開Ed25519鍵だけの設定で、private backendではない。公開Workerのsource・native binding closureでその鍵も一致させる。公開鍵があることを理由に架空のprivate componentを加えず、service bindingや別writer authorityの不在検証は維持する。

この文書は手順と契約を記述する。特定stagingでの適用済み・課金済みを示すものではない。実行時のschema version、source SHA、artifact/import digest、backup状態、review/custody、テスト日時・結果はoperator-runsとPR本文に記録する。本番の検証には使わない。


## Staging限定のrouting readback

Workers.devのintegration公開とmoney-owner証明は、[Cloudflare公式Worker Domains LIST](https://developers.cloudflare.com/api/resources/workers/subresources/domains/methods/list/)の`service` filterで対象Workerのcustom domain集合だけを読む。account全Worker/domainやzone-route inventoryへ広げない。全ページ・件数整合の既存guardは維持し、foreign service、unfiltered totals、filter/pagination不明はfail closedにする。global一覧を読み直したり、曖昧な応答を空集合とみなしたりしない。実CFのfiltered metadataはstaging実行時に確認し、このsource記述だけでnative routing資格済みとはしない。新money ownerはworkers.dev profileに限定する。
