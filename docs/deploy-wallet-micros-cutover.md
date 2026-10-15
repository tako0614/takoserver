# 既存integration D1のUSD-micros cutover

この経路は既存のstaging D1専用で、production・fresh generationの作成・0088→0092の適用資格を広げない。legacy stagingの証明経路に加え、既に元のcreatorで完成した`integration-ts`の固定92 originを明示選択できる。D1/R2を削除・作り直さず、0093分類準備、証拠投入、0094不可逆変換を別phaseとして実行する。0095以後は独立したsuffix qualificationが必要で、この経路から自動適用しない。

## 入口と資格

通常の`bun run deploy -- takoserver-d1-schema --status|--apply --environment=integration --commit=<exact SHA> --through-migration=0093|0094`を使う。operator-owned 0600 declarationを`TAKOSERVER_D1_MONEY_CUTOVER_DECLARATION_PATH`で指定する。declarationは絶対パス、正のstaging identity、phase、maintenance/source、保護された起源・writer inventory・backup・分類・review・custodyの各path/digestを束縛する。schema waveのowner adapterがnative readbackを行い、停止booleanを入力として採用しない。

この経路はproduction target設定やproduction D1を読まない。legacy分岐は既存generationの正常終了記録とpost-statusの正のstaging metadataを独立reviewしたcertificateを使い、明示fresh-origin分岐は以下の元creator custodyを使う。どちらも固定0001–0092 digest、native D1 UUID/nameとR2 nameの一致を求める。名前だけでは許可しない。秘密値・snapshot内容・provider生出力をログやPRへ出さない。

### 元のfresh92 custodyを使う明示分岐

`TAKOSERVER_INTEGRATION_STORAGE_ORIGINAL_CREATE_INPUT_PATH`を設定すると、同じintegration専用0093/0094 CLIだけが既存のbounded 0600 original-create locatorを読む。
この入力の`kind: positive-fresh-0092`、`custodyDirectory`と独立に保持したdevice/inode pinは、元のcreatorの入力そのものを選択する。credentialや結果証明ではない。
不在時は既存legacy certificate経路を維持する。一般のschema、production、別waveへこの入力を流用せず、`--contract`は入力を開かない。

money declarationではlegacyの`originCertificatePath`/`originCertificateDigest`に代え、`originalOrigin`だけを持つ。
その値は`invocation`と`originalTargetPath`の二つで、invocationは元の`action: apply`、`environment: integration`、40-hex `commit`、32-lowercase-hex `generation`、`namespace: integration-ts`、`freshLineage: v2-0092`の正確な六fieldである。
`originalTargetPath`は元create時に衝突を避けたincumbent integration targetであり、現在のnew targetや保存statusで置換しない。
declarationとこの元targetはprivate0700 root下のsingle-link 0600 regular fileをheld/nonblocking/no-followで有界読取し、fatal UTF-8、同一FD/pathと読取後のcurrentnessを確認する。

現在のtargetは同accountの正確な`integration-ts-<generation>` D1/R2 pair、元create ACKのD1 UUID、immutable `v2-0092` origin、明示writer policy/epoch、literal integration-/staging- Worker名と対応するworkers.dev originを選ぶ。
同じ`verifyIntegrationStorageOriginalCreate`が元のsealed92 source/import、dispatch/ACK/R2/terminal chain、現在のnative D1 UUID/nameとR2 nameを毎phaseで照合する。
これは現在DBをexact92へ戻す要求ではない。現在の93/94 schema/shape/fencesは既存phase executorが独立に検証し、dispatch直前とimport後にも元origin/current identityを再確認する。
originの`independent-origin-review-required`はそのまま保持し、legacy-reviewedや通常Host readinessへ昇格しない。

genuine native originを通った同一ownerのfrozen optionsだけを同process内で識別する。target JSON、read selector、コピーしたoptionsや差替えproof callbackではwriter provenanceを再構成できない。
既存のmaintenance publication、phase-specific review、backup、writer epoch、財務fence、保存則、no-overwrite custodyとUNKNOWN時の非再送はすべて必要である。
この分岐はpost94 suffix、qualified0098 realm、通常Host起動、CPE exact88/89 guard、epoch rotationや新grantを提供しない。source実装やcomponent protocol fixtureだけで実native cutoverの資格を主張しない。

## 順序

1. 専用`pre-wallet-usd-micros-quiesced` targetを、レビュー済みsourceから通常のWorker authority-cutoverでpublishする。全HTTP受付を503にし、scheduledのwallet/Stripe/reseller処理を止める。別のclean checkoutの正確なcommitから同じartifactをdry-run再buildし、正規authority-cutoverの保護terminal receiptのartifact/source/native Version/deploymentへ束縛する。source・native module bytes・binding closure・100% deployment・maintenance responseを前後で照合する。private componentのあるmanaged profileは検証済みのimmutable source inventoryとnative revisionを束縛し、金銭テーブルwriterを含まないことを独立reviewする。private backendを持たないstandalone profileは、public source inventoryとexact native binding closureからその不在を検証し、private componentやGit archiveを捏造しない。これを全WfP処理の停止証明とは呼ばない。
2. `freeze` statusで既存D1のfull exportをowned 0600 fileへ保護保存する。NULを正規化しlocal SQLiteへ全dumpを復元、schema/lineage/FK・table counts・typed byte-safe row digest・通貨前像をnative D1と照合する。statusはD1に書き込まないがbackup fileを作成できる。
3. statusが返す具体的なreview bindingに対して独立reviewを行い、保護された証拠を固定する。`freeze` applyで全監査金銭テーブルのINSERT/UPDATE/DELETEを閉じる**永続trigger**、空のwriter permit table、単一の承認writer epoch行を原子的に入れる。nonsecretの`moneyCutoverWriterEpoch`はtarget・native Worker Version binding・独立review・custody・sealed SQLに同じ値を束縛する。triggerはfreeze行がある間、または同じトランザクション内のpermit epochがDB側の承認epochに一致しない間、DMLを拒否する。新規受付停止とこのDB fenceを組み合わせ、遅れて到着する旧writerのDMLを再開後も拒否する。D1内のpendingゼロは外部Stripe checkout・in-flight webhook・provider action・全WfP invocationの完了を証明しない。外部決済の未解決状態はoperatorの別証拠で確認し、不明なら停止を維持する。
4. `prepare`（through0093）をstatus→review→applyし、監査済み0093だけを適用する。92→94を一括で飛び越えない。
5. `classify`でnon-purchased lotのexact key/kind/original amount/expiryとreview済み根拠を保護manifestに束縛する。全件一致を検証し、専用原子的importだけで分類証拠を投入する。purchasedを勝手にFreeへ変えるなどの推測はしない。
6. `convert` status→独立review→apply。pending holds/allocations/usage/settlements/Stripe/old usage group、実INTEGERと安全範囲、ledger/lot/allocation保存則、分類全件一致を確認する。old fence削除、**監査済み0094そのままのSQL**、migration ledger insert、新fence設置を単一sealed D1 file `/import`に収める。別呼出しで無防備な間を作らない。
7. exact94+fence、USD-micros policy、空のpermit、row/aggregate前像との保存則、foreign keys、classification/historyをreadbackしterminal custodyを記録する。新USD-micros Workerには明示的な`transaction-fenced-usd-micros-v1` target policyと同名のnative bindingが必須。通常のauthority-cutoverでpublishする際、freeze行が残る間は全HTTPとcronが停止し、専用の`503 money-cutover-freeze`応答だけを公開する。publication成功とserving readinessを混同しない。
8. latest mainの正規authority-cutover・source/native module/closure/100% deploymentと専用503を確認し、`resume` status→review→applyで**freeze行だけを削除する**。DELETE文自体もexact freeze binding、承認epoch、空permitを条件にする。財務20表と分類証拠のtrigger、freeze table、空のpermit table、承認epoch行は残す。新Workerの`Sql.run`/`Sql.batch`は固定target epochのpermit INSERT→元のSQL→permit DELETEを一回のD1 batchで実行し、失敗時は全体をrollbackする。SELECTと監査済みread-only introspection以外の`Sql.query`は保護batchへ通すか拒否する。resume後に同じnative Versionの正常health、全guard定義、空permit、freeze行不在を再検証してからterminal custodyを記録する。旧cents artifactを自動再開しない。その後wallet hold/capture/release/expiry、micros wire、実usage fold、replayとrefusalをstagingで再試験する。

全phaseはbinding-specific独立reviewとsame-D1 publication leaseを必要とする。statusのready表示、marker、source inventory、手入力の金額だけを適用許可にしない。SQL本体は変更せず、包むimport・財務fence・shapeを固定する。未知extra table/trigger、部分lineage、origin/private/source/module mismatchは拒否する。

## 失敗・復旧

D1 mutation前と後を区別し、dispatchをno-overwriteでfsyncしてから一度だけ送る。ACK不明・readback不明は同じDBのGET/SELECT照合だけを行い、blind再importしない。完成schemaに見えてもcustody・金額前像・保存則が一致するまで成功としない。

0094前の`abandon`は、convertのdispatchが無く、exact92/93+fence、金銭前像不変、外部cash pendingゼロ、maintenance維持、独立reviewがある場合にのみ、所有fenceを原子的に外す。Hostは503のまま保持する。旧承認artifactへの再公開は別の正規authority復旧操作で資格を満たす必要があり、現mainの94 guardを回避しない。

0094後のdown migrationやcents binaryへのrollbackは無い。保護backup・SQL内immutable preimages/aggregates・custodyからforward repairする。DBを削除・再作成しない。file import原子性はpinned Wranglerの`/import`実装、local D1/SQLite失敗注入、staging複製での途中失敗と成功の検証を束縛してから本targetへ適用する。複製DBを既存targetの代替にしない。0095は`stripe_events`を再作成して現triggerを落とすため、別waveが同一原子import内でこの永続guardを復元するまでは適用しない。将来の95/96やHosted Pricing sourceへ移る際は旧Workerと同じepochを再利用せず、先にfreezeして別のreviewed suffixでDB承認epochを原子的にrotateし、新target/native binding/sourceを照合する。現経路はepoch rotationも0095適用も提供しない。旧in-flight Stripe Checkoutが外部に作成したsessionはD1 guardだけでは消えず、別の正の照合とµ単位での処理が必要。

## 実証の境界

standalone HostのoperatorIdentityは検証済み公開Ed25519鍵だけの設定で、private backendではない。公開Workerのsource・native binding closureでその鍵も一致させる。公開鍵があることを理由に架空のprivate componentを加えず、service bindingや別writer authorityの不在検証は維持する。

この文書は手順と契約を記述する。特定stagingでの適用済み・課金済みを示すものではない。実行時のschema version、source SHA、artifact/import digest、backup状態、review/custody、テスト日時・結果はoperator-runsとPR本文に記録する。本番の検証には使わない。


## Staging限定のrouting readback

Workers.devのintegration公開とmoney-owner証明は、[Cloudflare公式Worker Domains LIST](https://developers.cloudflare.com/api/resources/workers/subresources/domains/methods/list/)の`service` filterで対象Workerのcustom domain集合だけを読む。account全Worker/domainやzone-route inventoryへ広げない。全ページ・件数整合の既存guardは維持し、foreign service、unfiltered totals、filter/pagination不明はfail closedにする。global一覧を読み直したり、曖昧な応答を空集合とみなしたりしない。実CFのfiltered metadataはstaging実行時に確認し、このsource記述だけでnative routing資格済みとはしない。新money ownerはworkers.dev profileに限定する。
