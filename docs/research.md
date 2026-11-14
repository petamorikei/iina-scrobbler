# 調査メモ: IINAプラグインとweb-scrobbler

調査日: 2026-11-13
対象: IINA 1.5.1（mpv 0.41.0同梱）、iina/iina v1.5.1ソース、iina-plugin-definition、iina-plugin-template、plugin-opensub、iina-jellyfin、web-scrobbler v3.24.0

凡例: 【確認】ソースまたは公式ドキュメントで確認した事実／【推測】ソース読解からの推論（実機未検証）／【未確認】clone外の知識で裏付けなし

IINAに関する記述は、iina/iina v1.5.1のソース（`iina/Plugin/JavascriptPlugin.swift`、`JavascriptPluginInstance.swift`、`JavascriptAPI*.swift`、`JavascriptPolyfill.swift`、`JavascriptMessageHub.swift`、`PlayerCore.swift`、`MPVController.swift`、`EventController.swift`）と、IINAが同梱するJust 0.8.0（`Just.swift`）を読んで得たもの。

既存のIINA用Last.fm Scrobblerは、GitHub検索（`iina scrobble`、`iina last.fm`）では見つからなかった。

---

## 1. IINAプラグイン

### 1.1 Info.json【確認】

- 必須: `name`、`identifier`（逆ドメイン形式）、`version`、`entry`、`author`（`{name, email?, url?}`、値はすべて文字列）
- 任意: `description`、`globalEntry`、`preferencesPage`、`preferenceDefaults`、`helpPage`、`sidebarTab`、`permissions`、`allowedDomains`、`ghRepo`/`ghVersion`（整数）、`localized`（1.5以降）
- **global entryのキーは`globalEntry`**（`JavascriptPlugin.swift:381`の`jsonDict["globalEntry"]`で確認）。公式ドキュメントとplugin-opensubにある`"global"`は無視される。`subProviders`も誤りで、正しくは`subtitleProviders`
- `permissions`: `network-request`、`show-osd`、`show-alert`、`video-overlay`、`file-system`
- `allowedDomains`: `"*"`、`"*.example.com"`、完全一致。今回は`["ws.audioscrobbler.com"]`だけでよい（`utils.open`はドメイン検査しない）
- プラグインは既定で無効。インストール後に設定画面で有効化が必要

想定するInfo.json:

```json
{
  "name": "Last.fm Scrobbler",
  "identifier": "io.github.<user>.iina-scrobbler",
  "version": "0.1.0",
  "ghVersion": 1,
  "author": { "name": "..." },
  "entry": "dist/index.js",
  "globalEntry": "dist/global.js",
  "preferencesPage": "pref.html",
  "preferenceDefaults": { "enabled": true, "scrobble_videos": false, "scrobble_percent": 50 },
  "permissions": ["network-request", "show-osd"],
  "allowedDomains": ["ws.audioscrobbler.com"]
}
```

### 1.2 開発とパッケージング【確認】

- `iina-plugin link <dir>`で`~/Library/Application Support/com.colliderli.iina/plugins/<dir>.iinaplugin-dev`にシンボリックリンクを作る。変更の反映はIINA再起動か「Reload All Plugins」
- `iina-plugin pack <dir>`で`.iinaplgz`（実体はzip、`node_modules`とドットファイルは除外）を作る
- GitHubからインストールさせる場合は、ビルド済みの`dist/`をコミットする
- デバッグ: Log Viewer（`global - <名前>`、`player<N> - <名前>`）、Plugin > Developer Tool、SafariのWeb Inspector
- entryはES moduleではなく通常のスクリプトとして評価される。バンドラ（公式推奨はParcel、esbuildでも可）でIIFEの単一ファイルを出力する
- 型定義はnpmの`iina-plugin-definition`。ただし誤りがある（1.6節）

### 1.3 main entryとglobal entry【確認】

|              | main entry                                   | global entry                                                                                                                          |
| ------------ | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| インスタンス | プレイヤー（PlayerCore）ごとに1つ            | IINA起動時に1つ                                                                                                                       |
| 使えるAPI    | 全API                                        | `menu`、`standaloneWindow`、`utils`、`file`、`preferences`、`console`、`http`、`ws`、`global`だけ（`core`、`mpv`、`event`は使えない） |
| メニュー     | そのウィンドウにフォーカスがあるときだけ表示 | 常に表示                                                                                                                              |

- PlayerCoreは破棄されず使い回される。main entryのインスタンスもウィンドウを閉じた後に残るので、**ファイルごとに状態とタイマーを必ずリセットする**
- 通信:
  - main→global: `iina.global.postMessage(name, data)`。global側は`onMessage(name, (data, playerLabel) => …)`で受ける
  - global→main: `postMessage(playerLabel, name, data)`。`postMessage(null, …)`はプラグインが作ったプレイヤーにしか届かない（ドキュメントと食い違い）
  - `onMessage`はメッセージ名ごとにリスナー1つ（後勝ち）
- `preferences`と`@data`は全インスタンスで共有される

**方針**【推測】: global entryが認証、セッション、送信キュー、HTTP送信、常設メニューを担当する。main entryが再生監視、閾値判定、OSD、Loveメニューを担当し、結果を`global.postMessage`で送る。キューの書き込みをglobalの1か所にまとめれば、複数ウィンドウでの競合も避けられる。

### 1.4 再生状態の取得

**イベント**【確認】（`event.on`は`iina.X`、`mpv.X`、`mpv.<prop>.changed`の形式だけ受け付ける）

- `iina.file-loaded`（URL文字列）、`iina.file-started`、`iina.window-will-close`、`iina.mpv-initialized`、`iina.menu-update`（1.5以降、Pluginメニューを開くたびに発火）など
- `iina.window-did-close`は型定義にあるが発火しない
- `mpv.end-file`、`mpv.start-file`、`mpv.seek`、`mpv.playback-restart`、`mpv.idle`など。**mpvイベントには引数がない**（`end-file`の理由は取れない）
- 一時停止は`mpv.pause.changed`（bool）で検知する。`pause`/`unpause`というmpvイベントは存在しない
- `mpv.media-title.changed`など、IINAが文字列形式で監視しているプロパティのchangedイベントは値が壊れる恐れがある【推測】。`mpv.getString`で読み直す

**値の取得**【確認】

- `core.status`: `paused`、`idle`、`position`、`duration`（取れなければnull）、`speed`、`url`、`title`、`isNetworkResource`など
- `mpv.getString(prop)`はプロパティが無ければnull。**`mpv.getNumber`は無くても0を返す**
- タグ: IINA自身は`metadata/by-key/artist`、`metadata/by-key/album`、`media-title`を使っている
- キー名はコンテナによって揺れる【推測】（ID3/MP4は`album_artist`、`track`、Vorbis/FLACは`ALBUMARTIST`、`TRACKNUMBER`）。`mpv.getNative("metadata")`で全キーを取り、小文字化して`_`や空白を除いてから照合する
- ネットラジオ（ICY）は`metadata/by-key/icy-title`に`Artist - Title`が入る【推測】。曲の切り替わりはポーリングで検知する
- 再生時間はjellyfinプラグインと同じく、`setInterval`で1秒ごとに`core.status`をポーリングするのが無難（`mpv.time-pos.changed`が動くかは未検証）

### 1.5 HTTP、永続化、認証、UI

**HTTP**【確認】

- `iina.http.post(url, {params, headers, data})`は`Promise<{statusCode, reason, data, text}>`を返す（内部はJust 0.8.0）
- `data`を渡し、`Content-Type: application/json`を指定しなければ`application/x-www-form-urlencoded`で送られる。Last.fmの要件に合う
- **`params`、`headers`、`data`の値はすべて文字列にする**。数値が混じると辞書全体が黙って空になる
- **ステータス400以上はreject**され、値は`{statusCode, reason, data, text}`のプレーンなオブジェクト（`Just.swift:216`の`ok`判定による）
- Last.fmのAPIエラーは、resolve側（2xxで本文に`error`）とreject側（`e.data.error`）の**両方**で`data.error`を確認する【推測、実機で要確認】
- タイムアウトは指定できない。`network-request`権限と`allowedDomains`が必要

**永続化**【確認】

- `preferences.get/set`。コードから`set`したら`sync()`を呼ぶ（呼ばないとファイルに保存されない）。値の変更イベントはない
- 設定画面HTMLが使えるのは`iina.preferences.get/set`だけで、`data-pref-key`で入力要素と自動的に結び付く。プラグイン本体へメッセージを送る手段はない。`"`、改行、`\`を含む値は壊れる
- `iina.file`の`@data/...`は`file-system`権限なしで読み書きできる（`plugins/.data/<id>/`）。書き込みはアトミック。送信キューは`@data/queue.json`に置く
- `utils.keychainWrite/keychainRead`でキーチェーンも使える（型定義の`keyChainWrite`は誤り）。起動時にシステムのパスワード入力を求められることがある

**認証**【確認＋推測】

- `utils.open(url)`はhttp(s)のURLを権限やドメインの検査なしで既定のブラウザで開ける
- IINAにはURLスキームでのコールバックもHTTPサーバーもない。許可の完了は次のどちらかで受け取る
  - `auth.getSession`をポーリングする（未承認の間はerror 14が返る想定【未確認】）
  - 「許可しました」メニューを押してもらってから取得する
- standaloneWindowやsidebarのWebViewにLast.fmのページを表示するのは避ける。遷移ポリシーが「`canAccess`を通るURLをキャンセルし、それ以外を許可する」という逆向きの実装になっている（`PluginStandaloneWindow.swift:77-83`、`PluginSidebarView.swift:39-45`）【確認、実際の挙動は要確認】
- standaloneWindowを使う場合、`loadFile()`は`onMessage`のリスナーを消すので、その後に登録する

**UI**【確認】

- `core.osd(msg)`は`show-osd`権限が必要で、main entryからしか呼べない
- `menu.item(title, action, {enabled, selected, keyBinding})`で項目を作る。`iina.menu-update`で作り直すと「Love: 曲名」の表示や有効/無効のチェックマークを更新できる
- サブメニューの追加は`addSubMenuItem`（型定義の例にある`addSubmenuItem`は誤り）

### 1.6 JS実行環境と注意点

- 素の`JSContext`。IINAが追加するグローバルは`iina`、`setTimeout`/`setInterval`（IDは文字列）、`require`、`module`だけ【確認】
- `fetch`、`crypto`、`TextEncoder`、`URLSearchParams`、`atob`は無い【推測、JXAで確認】。async/await、`?.`、`??`は使える
- **MD5は純JSで実装して同梱する**。`utils.exec`で`/sbin/md5`を呼ぶ案は採らない（`file-system`権限が必要で、コマンドラインがログに残りsecretが漏れる）
- `require`はキャッシュが効かない疑いがある【推測】。バンドラで1ファイルにまとめる
- 型定義の誤り:
  - `HTTPRequestOption`の各フィールドが必須になっている
  - `utils.chooseFile`の戻り値（実際はPromise）
  - `iina.mpv-inititalized`の綴り（1.5.1では`mpv-initialized`）
- 1.4.1と1.5.1の差: `localized`、`iina.menu-update`、`mpv.set`/`mpv.command`の権限チェック、インスタンス破棄時のタイマー解除などは1.5で追加された。Info.jsonのキーとHTTP APIの形は同じ

---

## 2. web-scrobbler

### 2.1 アーキテクチャ【確認】

connector（サイトごとのDOM取得）→ Controller（状態機械、scrobble判定）→ Pipeline（Normalize→UserInput→RegexEdits→track.getInfo→…）→ ScrobbleService → 各Scrobbler（Last.fm、Libre.fm、ListenBrainz、Maloja、Webhookなど）

- `BaseScrobbler`の抽象メソッド: `getAuthUrl`、`getSession`、`sendNowPlaying`、`scrobble(songs[])`、`toggleLove`、`getSongInfo`など
- 結果は`ServiceCallResult`（`ok`/`ignored`/`error-auth`/`error-other`）に統一
- `AudioScrobbler`がLast.fm互換APIの共通実装。Libre.fmはURLとkeyを差し替えるだけ

### 2.2 Last.fm API【確認】

- エンドポイント: `https://ws.audioscrobbler.com/2.0/`、認可ページ: `https://www.last.fm/api/auth/`
- API key/secretはソースに直書き。**流用せず、自分で取得する**

| メソッド                    | HTTP | 署名                                                        | 備考                                                                            |
| --------------------------- | ---- | ----------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `auth.getToken`             | GET  | web-scrobblerは無し（公式仕様は署名付きとされる【未確認】） |                                                                                 |
| `auth.getSession`           | GET  | 有り                                                        |                                                                                 |
| `track.updateNowPlaying`    | POST | 有り                                                        | artist、track、album、albumArtist、duration                                     |
| `track.scrobble`            | POST | 有り                                                        | `artist[i]`、`track[i]`、`timestamp[i]`、`album[i]`、`albumArtist[i]`、最大50件 |
| `track.love`/`track.unlove` | POST | 有り                                                        |                                                                                 |
| `track.getInfo`             | GET  | 無し                                                        | 補正と情報表示用                                                                |

**api_sig**: `format`と`callback`を除く全パラメータ（`api_key`を含む）をキー名でソートし、`key + value`を連結し、末尾にsecretを付けて**UTF-8で**MD5を取る。

**エラー**: web-scrobblerはerror 9（Invalid session key）でサインアウトするだけで、11/16（一時的な障害）や29（レート制限）の再試行はない。

### 2.3 認証フロー【確認】

`auth.getToken` → `https://www.last.fm/api/auth/?api_key=…&token=…`をブラウザで開く → ユーザーが許可 → `auth.getSession`でsession key（無期限）とユーザー名を取得して保存。callback URLを使わないデスクトップ型で、IINAに向いている。tokenは60分有効で1回だけ使える。

### 2.4 Scrobble判定【確認】

```ts
// util/util.ts
if (isDurationInvalid(duration)) return 30;   // 長さ不明なら30秒
if (duration < 30) return -1;                 // 30秒未満は対象外
return Math.min(Math.round(duration * percent / 100), 240); // percentは既定50、10〜100で設定可
```

- 時間は**一時停止を除いた実際の再生時間**（壁時計ベース）で数える。再生位置は使わない。シークで飛ばした分は数えない
- timestampは曲を検出した時刻（`Math.floor(Date.now()/1000)`）
- nowPlayingは曲の処理後に1回送る。一時停止からの再開時、未送信なら送る。一時停止自体はLast.fmに通知しない
- リピート検出: 経過時間が曲の長さ以上になったら、次の更新で新しい曲として扱う
- 曲の変化はartist、track、album、uniqueIDのいずれかの変化で判定する

### 2.5 メタデータ処理

- 【確認】全フィールドにtrim、NBSPの置換、NFC正規化をかける
- 【確認】`media-title`のような1行タイトルを分ける区切り文字の候補（この順で試す）: `' -- '`、`'--'`、`' ~ '`、`' - '`、`' – '`、`' — '`、`' // '`、片側だけ空白の`-`/`–`/`—`、`':'`、`'|'`、`'///'`、`'/'`、`'~'`（`core/content/util.ts`）
- 【確認】YouTubeタイトルの整形`processYtVideoTitle`: 先頭の`[genre]`や`【…】`、トラック番号、`(MV)`、`【PV】`などを除き、`Artist「Track」`のような形も解釈する
- 【未確認】`@web-scrobbler/metadata-filter`パッケージ（cloneに本体なし）には、`(Official Video)`やremaster表記などを除くフィルタ（`createYouTubeFilter`、`removeRemastered`など）がある
- 【確認】ユーザー編集（saved edits）: 元のartist、track、album、albumArtistのMD5をキーに、修正後の値を保存して次回から適用する
- 【確認】`track.getInfo`の結果でartist、track、durationを補正する

### 2.6 失敗時の扱い【確認】

- **自動再送もオフラインキューもない**。scrobble cache（上限1000件の履歴）から手動で再送するだけ
- Last.fmは古すぎるtimestamp（おおむね2週間より前）を拒否する【未確認】。オフラインキューの保持期間はこれに合わせる必要がある
- バグと思われる箇所【推測】:
  - `track.scrobble`の一括送信で曲ごとの`ignored`を返しておらず、全件成功扱いになる
  - `getInfo`が失敗しても`{}`が返るため、「Last.fmが知らない曲」の判定が実質働いていない

### 2.7 ライセンス

- web-scrobbler本体はMIT（Copyright © 2010-2023 David Šabata & Web Scrobbler Team）。著作権表示を残せば流用できる
- `@web-scrobbler/metadata-filter`と`blueimp-md5`もMITのはず（未確認）

---

## 3. 設計に向けた要点

1. **構成**: global entry（認証、セッション、キュー、送信、常設メニュー）＋main entry（再生監視、判定、OSD、Love）。TypeScript＋バンドラでIIFE出力
2. **曲情報**: `iina.file-loaded`で`mpv.getNative("metadata")`を正規化してartist、title、album、album_artistを取る。タグが無いときは`media-title`をweb-scrobblerの区切り候補で分割する。ストリームは`icy-title`の変化を監視する
3. **判定**: 1秒ごとのポーリングで、一時停止とアイドルを除いた再生時間を積算する。閾値はweb-scrobblerと同じ（30秒未満は対象外、`min(長さ×50%, 240秒)`、長さ不明なら30秒）。timestampは再生開始時刻
4. **送信**: `http.post`でform-urlencoded、値はすべて文字列。MD5は純JSで実装する
5. **エラー**: resolveとrejectの両方で`data.error`を見る。9なら再認証を促す。11/16/29とネットワーク障害はキュー（`@data/queue.json`）に残して後で再送（最大50件ずつ）。一括送信の結果は曲ごとに判定する
6. **認証**: メニュー → `auth.getToken` → `utils.open` → `auth.getSession`をポーリング → session keyを`preferences`（`sync()`）かキーチェーンに保存
7. **「Last.fmが知らない曲」をscrobbleしない理由にしない**（ローカルファイルには未登録の曲が多い）。2026-11-14、web-scrobblerの既定に合わせて改めた（design.md D5、8.7）

## 4. 未決定事項

- 動画もscrobbleするか（音声ファイルのみ／タグ付きのみ／全部）
- session keyの保存先（preferencesかキーチェーンか）
- Libre.fm、ListenBrainzなど他サービスへの対応を将来考えるか
- Last.fm APIアカウント（API key/secret）の取得と扱い。secretをコードに埋め込むと、配布物（コミットした`dist/`を含む）から読み取れる。埋め込むか、ユーザーに自分のkey/secretを設定させるか

## 5. 実機で確認すべきこと

- `mpv.metadata.changed`、`mpv.time-pos.changed`が発火するか
- `mpv.end-file`と`iina.window-will-close`の実際の順序
- 未承認時の`auth.getSession`がreject側に来るか（error 14）
- ICYストリームで`icy-title`が取れるか
- FLAC/MP3/M4Aそれぞれで`metadata`のキー名がどうなるか

## 6. yt-dlp経由の再生で取れる曲情報

IINAでyt-dlpを使う経路は2つあり、Online Mediaプラグイン（`io.iina.ytdl`）を有効にすると、mpv内蔵のytdl_hookは無効になる（プラグインのdescriptionより）。開発環境ではOnline Media 0.9.10が有効になっている。

| 経路                                                                     | 渡される情報                                                                                                                                                                                                        |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| mpv内蔵ytdl_hook（mpv 0.41.0の`player/lua/ytdl_hook.lua`）               | `force-media-title`＝動画タイトル。加えて`!global_tags`で`artist`、`album`、`album_artist`、`track`→`title`、`track_number`、`uploader`、`genre`、`upload_date`、`ytdl_description`などを`metadata`に入れる【確認】 |
| Online Mediaプラグイン（`src/add-video.ts:119`、`src/ytdl-hook.ts:180`） | `force-media-title`＝動画タイトルだけ。artist、track、uploaderなどは`metadata`に入らない【確認】                                                                                                                    |

- yt-dlpの`artist`/`track`/`album`はYouTube Musicの自動生成動画など、音楽として認識されたものだけに入る【未確認】
- `path`には元のURLが残る想定【推測、実機で要確認】

web-scrobblerのYouTube connector（`src/connectors/youtube.ts`）は、次の順に試して最初にartistとtrackがそろったものを使う【確認】:

1. チャプター名（チャプターがある動画だけ）を`processYtVideoTitle`で分割
2. 概要欄（YouTube Musicの自動生成動画の「Provided to YouTube by …」形式）を`parseYtTopicVideoDescription`で解析（album付き）
3. 動画タイトルを`processYtVideoTitle`で分割。artistが取れなければチャンネル名から「- Topic」「- トピック」などを除いたものをartistにする

ほかに、YouTube Music APIで照会するオプション、カテゴリ（Music/Entertainment）で絞り込むオプションがある（どちらも既定は無効）。つまり、動画タイトルだけでは同じ振る舞いにならない。チャンネル名と概要欄が要る。Online Media経由では、チャプターは概要欄から作られて`chapter-list`に入る（`add-video.ts:159-160`）が、チャンネル名と概要欄は取れない。

取れる情報を増やす方法:

1. `media-title`をweb-scrobblerの`processYtVideoTitle`相当で分割する（追加の通信なし。ただし「Artist - Topic」チャンネルのように、タイトルに曲名しかない動画は分けられない）
2. 本プラグインから`utils.exec`で`yt-dlp -j --skip-download <URL>`を実行し、`artist`、`track`、`album`、`uploader`、`channel`を取る（`file-system`権限が必要。再生とは別に通信が1回増える）
3. Online Mediaプラグインに、mpv内蔵ytdl_hookと同じ`!global_tags`を付けるよう提案する（上流での対応待ち）

## 7. 決定事項（2026-11-13）

- 動画も対象にする。yt-dlpで再生する外部の動画も対象にする
- 連携の手順はweb-scrobblerと同じく簡易にする（ユーザーにAPI keyを発行させない）。API keyとsecretはプラグインに同梱する
- session keyはプラグインの設定（preferences）に保存する
- 動画の曲情報はA（`media-title`の分割）とB（本プラグインから`yt-dlp -j`を実行してチャンネル名と概要欄を取る）を組み合わせ、web-scrobblerと同じ順（チャプター→概要欄→タイトル＋チャンネル名）で判定する。Bは既定で有効にする。`file-system`権限を宣言する
  - `utils.exec`はコマンド名だけだとIINA同梱のバイナリ（`Contents/MacOS/youtube-dl`など）しか解決しない。システムのコマンドは絶対パスで渡す（`JavascriptAPIUtils.swift:106-137`で確認）。yt-dlpの場所は、設定で指定したパス、`/opt/homebrew/bin/yt-dlp`、`/usr/local/bin/yt-dlp`、IINA同梱の`youtube-dl`の順に探す想定
- 他サービス（Libre.fm、ListenBrainzなど）への将来対応の余地を残す（`BaseScrobbler`相当の抽象化）

## 8. 実機確認の結果（2026-11-13、IINA 1.5.1）

この章の結果は、1章（`getString`の戻り値、`time-pos.changed`、global→main通信）、5章（HTTPエラーの返り方）、6章（`path`）の推測より優先する。

確認用プラグイン`probe/`（`io.github.iina-scrobbler.probe`）を`iina-plugin link`で読み込み、`iina-cli --mpv-input-ipc-server=…`で起動したIINAをmpvのIPCで操作して確認した。テスト用のファイルはffmpegとmetaflacで作った無音のMP3、FLAC、M4A、Opus、MP4、MKV。

### 8.1 global→mainへの同期的な返信でIINAが落ちる（最重要）

- global entryの`onMessage`ハンドラの**中から同期的に**`iina.global.postMessage(<player label>, name, data)`で返信すると、**JavaScriptCoreのヒープが壊れ、GCのタイミングでIINAがクラッシュする**（`WTF::StringImpl::~StringImpl()`で`EXC_BREAKPOINT`）
  - main entryから受け取ったオブジェクトをそのまま送り返すと、起動から約70秒、3つ目のファイルあたりで必ず落ちた（3回再現）
  - 数値だけのオブジェクトを送った場合も、再生中は落ちなかったがIINA終了時に同じクラッシュが起きた
  - どちらの場合も、返信はmain entryのリスナーに届かなかった
- 返信を`setTimeout(…, 0)`でハンドラの外に遅らせ、中身をJSON文字列にすると、**8件すべて届き、再生中も終了時も落ちなかった**（遅延とJSON文字列のどちらが効いたのかは切り分けていない）
- main→global（`iina.global.postMessage(name, data)`）だけなら、約2分、8ファイルの切り替えでも落ちず、終了時のクラッシュもなかった
- 切り分け: プラグイン無効→落ちない／タイマー、OSD、高頻度イベントを個別に切っても落ちる／メッセージを切ると落ちない／main→globalのみ→落ちない／遅延した返信→落ちない
- iina-jellyfin（`src/global.js:15-59`）もハンドラの中から同期的に返信しているので、同じ問題を抱えている可能性がある【推測】
- **設計への影響**: global→mainの返信は、必ず`setTimeout`でハンドラの外に出してから送る。ペイロードは両方向ともJSON文字列にする

### 8.2 イベント

- `mpv.time-pos.changed`は発火する（毎秒約17回、引数は秒数）。`playback-time`、`percent-pos`も同様
- `mpv.pause.changed`は引数がbool。再生中は`core.status.paused`と一致するが、読み込み直後には`pause.changed [true]`が来ても`core.status.paused`がfalseのことがある
- `mpv.metadata.changed`はプレイヤー起動時に1回（引数0）発火するだけで、**ファイルが変わっても発火しない**。曲情報は`iina.file-loaded`で読む
- `mpv.end-file`、`mpv.start-file`、`mpv.seek`、`mpv.playback-restart`は引数なし
- ファイル切り替え時の順序: `mpv.playlist-pos.changed`→`mpv.end-file`→`iina.file-started`→`mpv.start-file`→`mpv.duration.changed`(0)→…→`iina.file-loaded`(URL)→`mpv.file-loaded`→`mpv.duration.changed`(長さ)→`mpv.playback-restart`。曲が最後まで再生されたときは`mpv.end-file`が`playlist-pos.changed`より先に来る
- `loop-file`でループしたときは`mpv.seek`と`mpv.playback-restart`だけが発火し、位置が0に戻る。`file-loaded`は発火しないので、リピートは位置の巻き戻りで判定する必要がある
- 読み込みに失敗したとき（再生できないYouTube動画）は、`mpv.end-file`→`mpv.idle`→`mpv.idle-active.changed`(true)→`iina.window-will-close`の順に発火し、ウィンドウが閉じた。再生中のファイルを`stop`したときの順序は未確認
- `iina.mpv-initialized`、`iina.window-did-close`は発火しなかった
- 音声ファイルではIINAが自動でミュージックモードに切り替え、`iina.music-mode.changed`が発火する

### 8.3 タグとプロパティ

- `metadata/by-key/<key>`は大文字小文字を区別しない（`ARTIST`でも`artist`でも取れる）
- ffmpegが正規化するので、`ALBUMARTIST`は`album_artist`、`TRACKNUMBER`は`track`として取れる（metaflacで書いたFLACで確認）。一方、`getNative("metadata")`のキーはファイルのまま（`TITLE`、`ARTIST`など大文字）なので、**読み出しは`by-key`を使う**
- 日本語タグはMP3（ID3v2.3）、FLAC、M4A、Opus、MP4ですべて正しく取れた
- タグがないファイルでは、`media-title`も`core.status.title`も**拡張子付きのファイル名**（例: `05-Untagged Artist - Untagged Song.mp3`）
- `mpv.getNumber`は存在しないプロパティで`0`、`getString`と`getNative`は`undefined`
- `core.status.duration`と`getNative("duration")`はどちらも取れる（ファイル切り替え直後は0）
- 1秒ごとに`core.status`をポーリングすると、一時停止中は位置が止まり、シークは値の飛びとして見える

### 8.4 yt-dlpとOnline Media

- YouTubeの動画（Online Media 0.9.10経由）では、`metadata`は`null`、`media-title`は動画タイトル、`path`は元のURL、`stream-open-filename`はgooglevideoのURL。**mpvのmetadataからartistなどは取れない**（6章の読みどおり）
- 読み込み開始から`iina.file-loaded`まで約5.5秒。その前から`media-title`は`watch?v=…`になっている
- プラグインから`utils.exec("/opt/homebrew/bin/yt-dlp", ["-J", "--no-playlist", "--skip-download", "--no-warnings", "--ignore-no-formats-error", url])`を実行すると、1.8秒で`artists`、`track`、`album`、`channel`、`categories`、概要欄（「Provided to YouTube by …」）が取れた（出力は約130KB）
  - `artist`はカンマ区切りの連結文字列（区切りが全角の「，」になることもある）。**`artists`配列を使う**
  - 地域制限などで再生できない動画でも、`--ignore-no-formats-error`を付ければメタデータは取れる
  - 存在しない動画IDでも終了コード0で、`title`が`youtube video #<id>`、ほかの項目がすべて`null`になることがある。この結果は捨てる必要がある
- `utils.exec`のコマンド名解決: `"yt-dlp"`（名前だけ）は失敗、`"youtube-dl"`はIINA同梱の`Contents/MacOS/youtube-dl`（2026.08.19）に解決、`/opt/homebrew/bin/yt-dlp`（2026.10.26）は絶対パスで成功。存在しないパスは`-1`でreject

### 8.5 HTTP、JS環境、MD5

- 無効なAPI keyで`auth.getSession`を呼ぶと、GETでもPOSTでも**reject**され、値は`{statusCode: 403, reason: "forbidden", data: {error: 10, message: …}, text}`（`Error`ではないプレーンなオブジェクト。`data`はJSON解析済み）
- global entryの`iina`にあるのは`utils`、`menu`、`console`、`standaloneWindow`、`ws`、`global`、`http`、`file`、`preferences`
- `fetch`、`crypto`、`TextEncoder`、`URLSearchParams`、`atob`、`localStorage`は無い。`setTimeout`、`setInterval`、`require`、`unescape`、`encodeURIComponent`、`?.`、`??`、スプレッド構文は使える
- `require("./md5.js")`で読み込んだ純JSのMD5は、IINA上でも既知のテストベクトル（日本語を含む）と一致した。Node上ではNodeの`crypto`と2010件一致
- `file.write("@data/…")`での書き込みは動いた。ソース上は`file-system`権限なしでも書けるはずだが、このプローブは`file-system`を宣言しているので、権限なしの場合は未確認

### 8.5.1 Last.fmの認証フロー（有効なAPI key）

- `auth.getToken`は署名なしでも署名付きでもGETで200が返り、`{token}`（32文字）が取れる。どちらでもよいが、仕様に合わせて署名付きにしておく
- 承認前の`auth.getSession`は**reject**され、`{statusCode: 403, data: {error: 14, message: "Unauthorized Token - This token has not been authorized"}}`。ポーリングではerror 14を「待機中」として扱えばよい
- `utils.open(認証URL)`は`true`を返し、既定のブラウザで許可画面が開いた
- 許可後、5秒間隔のポーリングの2回目で`auth.getSession`が200を返し、`session: {name, key（32文字）, subscriber: 0}`を取得。`preferences.set`と`sync()`で保存でき、plistに`session_key`と`session_name`が書かれた
- 注意: プローブは`text`を伏せずにログへ書くので、tokenがそのまま残った。本番ではtoken、session key、secretをログに出さない
- `track.updateNowPlaying`（POST、署名付き）に`artist: "署名テスト アーティスト"`、`track: "UTF-8 & 記号 = ? / テスト"`を送ると200が返り、Last.fmのプロフィールにもそのまま表示された。純JSのMD5による署名と、`iina.http`のフォームエンコード（`&`、`=`、`?`、`/`、日本語、空白）は正しく動く
- 成功時の応答は`{nowplaying: {artist, track, album, albumArtist: {"#text", corrected}, ignoredMessage: {code, "#text"}}}`。`ignoredMessage.code`が`"0"`以外なら、Last.fmが無視したことを示す（scrobbleの応答も同じ形のはずなので、本番で確認する）

### 8.5.2 再生元ごとの違い（2回目の確認）

直接のメディアURL（SoundHelixのMP3）、ネットラジオ（SomaFM Groove Salad、ICY）、Online Mediaを無効にしたYouTubeを、同じ手順で確かめた。

- **直接のメディアURL**: `iina.file-loaded`の時点で`stream-open-filename`は`path`と同じ。長さ（372.7秒）もID3タグ（`artist`など）も取れた。タイトルタグがないので`media-title`はファイル名（`SoundHelix-Song-1.mp3`）
- **ネットラジオ**:
  - `stream-open-filename`は`path`と同じ
  - **`duration`はnullにならない**。読み込んだバッファの長さ（0.65秒→19.6秒→49.7秒…）で増え続け、`mpv.duration.changed`が毎秒数回発火する。「長さが取れない」ではネットラジオを見分けられない
  - `metadata`に`icy-title`、`icy-genre`、`icy-name`、`icy-notice1`などが入る。`icy-title`は`Artist - Title`形式で、`media-title`も同じ値になる
  - 曲が変わると`icy-title`と`media-title`は更新される（約30秒の間に1回変わった）が、`mpv.metadata.changed`は発火しなかった。曲の変化を追うならポーリングが要る
- **YouTube（Online Media無効）**: 読み込み開始から2秒で`mpv.end-file`→`mpv.idle`→`iina.window-will-close`となり、再生できなかった。この環境ではmpv内蔵のytdl_hookが動いていない（IINAの設定で無効か、yt-dlpが見つからないためと思われる【推測】）。内蔵ytdl_hook経由の判定は確かめられなかった
- **`loop-playlist`で1曲だけ**: 曲の終わりで`mpv.end-file`→`iina.file-started`→`iina.file-loaded`と、新しいファイルと同じイベントが来る（`loop-file`とは違う）
- **再生中の`stop`**: `mpv.end-file`→`mpv.idle`→`mpv.idle-active.changed`(true)→`mpv.duration.changed`(0)→`mpv.playlist-pos.changed`(-1)→`iina.window-will-close`。ウィンドウも閉じた
- **IINAの終了**: `mpv.shutdown`が発火した

### 8.5.3 global entryの読み込み中に`menu.forceUpdate()`を呼ぶと、main→globalのメッセージが届かなくなる（本体の実装中に発見）

- **症状**: main entryの`iina.global.postMessage(name, data)`が、エラーも出さずにglobal entryの`onMessage`に届かない。ペイロードが文字列でもオブジェクトでも同じ。同じ実行で確認用プラグインのメッセージは届いた
- **原因**（IINA 1.5.1のソース）:
  1. `menu.forceUpdate()`は同期的に`MenuController.updatePluginMenu()`を呼び、その中で`PlayerCore.active`を読む
  2. 起動直後はこれが最初のPlayerCoreを作り、プラグインのmain entryのインスタンスも作る
  3. main entryのインスタンスは、作られた時点の`plugin.globalInstance`を`parentAPI`として覚える（`JavascriptPluginInstance.swift:181`）
  4. global entryのスクリプトの評価中は、`plugin.globalInstance`にまだ代入されていない（`JavascriptPlugin.swift:158`は初期化が終わってから代入する）。そのため`parentAPI`がnilのまま残る
  5. `JavascriptAPIGlobalChild.postMessage`は`parentAPI?.messageHub…`なので、nilだと黙って何もしない
- **対策**: global entryの読み込み中は`menu.addItem`だけにして、`menu.forceUpdate()`は呼ばない（読み込み時に追加した項目は、`forceUpdate`なしでもメニューに出る）。`forceUpdate()`は読み込みが終わった後（認証の状態が変わったときなど）にだけ呼ぶ
- 同じ理由で、global entryの読み込み中に`PlayerCore.active`を読む他のAPIも避けたほうがよい【推測】

### 8.5.4 本体での実機確認（2026-11-13）

- テスト用の8ファイルを24秒ずつ再生し、タグ付きの6曲とファイル名から曲情報を取った1曲がscrobbleされ、Last.fmの記録にも残った。タグのない動画（`07-Show Name - S01E01.mkv`）は送らなかった。一時停止した6秒は再生時間に数えなかった
- 一度だけ、1曲がscrobbleの閾値に届かなかった。単独で再生し直すと再現しなかったので、1秒ごとのタイマーが遅れ、1回分の加算を2秒に制限していたため取りこぼしたと推測している【推測】（ミュートしたIINAが背面にあり、macOSがタイマーを間引いた可能性）。加算の方法を、壁時計の差と再生位置の進みの小さいほうに改めた（design.md 5.2）。改めた後の8ファイルの再生では取りこぼしはなかった

### 8.5.5 未送信キューの実機確認（2026-11-13）

- 未連携の状態でテスト用のファイルを再生すると、scrobbleは送られずに`@data/queue.json`に入った（`iina.file`の`exists`、`read`、`write`で読み書きできた）
- キューの2件のtimestampを2日後にずらして連携した状態でIINAを起動すると、起動3秒後の送信で2件をまとめて`track.scrobble`に送った。応答の`scrobbles.scrobble`は**配列**で、どちらも`ignoredMessage.code`が`"1"`（無視された）だった。Last.fmの記録には残らず、キューは空になった
  - timestampが未来すぎる場合のコードは`4`だと思っていたが、実際には`1`が返った。コードの意味に頼らず、`"0"`以外は「無視された」として扱えばよい
- 通信の失敗と再送の間隔（1分から倍々で最大1時間）は、単体テストだけで確かめた（実機でネットワークを止めて試してはいない）

### 8.5.6 yt-dlpによる曲情報と再生元の切り替えの実機確認（2026-11-13）

- Online Media経由でYouTubeの音楽動画（`mJ1N7-HyH1A`）を再生すると、プラグインが`/opt/homebrew/bin/yt-dlp`を実行し、2.0秒で`artists: ["YOASOBI", "Ayase"]`、`track: "夜に駆ける"`を得た。再生が始まった後に届いても、その再生のセッションとして数えられた（送信は未連携にして止めた）
- `scrobble_ytdlp`と`scrobble_local`をオフにすると、それぞれ「turned off for this source」となり、yt-dlpも実行されなかった

### 8.6 未確認

- ICYストリームで曲が変わったとき、新しい曲として数え直せるか（1曲目の取得とscrobbleは8.8で確認済み。曲の切り替わりは単体テストだけ）
- ウィンドウを手で閉じたときのイベントの順序（`stop`のときと同じと推測）
- mpv内蔵ytdl_hook経由の再生で、`stream-open-filename`が置き換わるか
- ウィンドウが閉じた後のPlayerCore再利用: 閉じた後にIPCで読み込ませたファイルではプローブのイベントが発火せず、`iina-cli`でURLを開くとIINAの2つ目のプロセスが起動した。プロセスごとにglobal entryが1つずつ動き、`@data`を共有することになるので、キューの書き込み競合に注意が必要
- 遅延した返信でオブジェクトをそのまま送った場合（8.1の切り分け）

### 8.7 web-scrobblerの「送らない」扱い（ソースで確認、2026-11-14）

2026-11-12時点のweb-scrobbler（`72b985b`）のソースで確かめた。design.mdのD3とD5の根拠。

- **アーティストか曲名が空**: その曲は何も送らない。「再生中」も送らない（`core/object/controller/controller.ts`で`Util.isArtistTrackEmpty`なら`reset()`）
- **長さが不明**: `util/util.ts`の`getSecondsToScrobble`は、長さがない、NaN、無限大のとき`DEFAULT_SCROBBLE_TIME`（30秒）を返す。ライブ配信だけを除く処理はない。YouTubeのコネクタにも、ライブ配信の特別扱いはない（除外の理由は広告、背景のタブ、カテゴリの設定だけ）
- **Last.fmが知らない曲**: 設定は3つ。既定は「Scrobble recognized or edited tracks」で、`track.getInfo`で見つかった曲か、利用者が手で直した曲だけ送る意図になっている（`core/object/pipeline/metadata.ts`、`core/storage/options.ts`）。ほかに「Force track recognition」（見つからなくても送る）と「Scrobble edited tracks only」がある
- **ただし既定の判定は実際には働いていない**: 曲が見つからないと`getSongInfo`は例外になり、結果は`[null]`になる。それをまとめる`getInfo`が`reduce(…, {})`で初期値の`{}`を返すので、`songInfo !== null`は常に真になる。Last.fmと連携していれば、どの曲も「知っている」と判定される。2.6の推測が確かめられた
- **見つかった曲の補正**: `track.getInfo`の結果で、アーティスト名、曲名、長さを置き換える（`INFO_TO_COPY`）

### 8.8 認識の確認、ライブ配信、ネットラジオの実機確認（2026-11-14）

- **`track.getInfo`の応答**（開発用のキーで確認）:
  - 知っている曲: HTTP 200で`track`が返る。大文字小文字や表記の違いは吸収される（`yoasobi`でも`YOASOBI`、`Keston And Westdal`でも`Keston and Westdal`が返る）
  - 知らない曲: **HTTP 200**で`{"error":6,"message":"Track not found"}`。テストで送った「Metaflac Artist - Metaflac Title」も、記録はあるが見つからなかった
  - API keyがない: HTTP 400で`{"error":6,"message":"Invalid parameters - Your request is missing a required parameter"}`。同じerror 6なので、文言で区別する必要がある
- **ローカルファイル**（送信は止めて確認）: 存在しないアーティストのタグを付けたファイルと、タグのない`12-Track 01 - Intro.mp3`（ファイル名から「Track 01 - Intro」と推測）は、どちらも「Last.fmが知らない」として送らなかった。YOASOBIのタグを付けたファイルは20秒でscrobbleの対象になった
  - 確認の答えは再生開始の約0.8秒後に届く。最初の版は答えを待つ間に再生開始の時刻を取り逃し、数え始めなかった。答えが届いた時点でファイルの再生開始時刻を読むように直した
- **ネットラジオ**（SomaFM Groove Salad）: 再生開始の3秒後に`icy-title`から「Chris Coco - Love Made Me Tough」を取り、Last.fmが知っている曲として数え、30秒でscrobbleの対象になった
- **YouTubeのライブ配信**（「知らなくても送る」をオンにして確認）: yt-dlpが`is_live: true`を返し、長さ（読み込み済みの分で19.9秒、64.9秒…と増える）を無視して、30秒でscrobbleの対象になった
  - yt-dlpはライブ配信の`title`の末尾に開始日時（`… 2026-11-14 11:01`）を付ける。時刻の`:`が区切りとして使われ、曲名が「01」になった。日時のない`fulltitle`を使うように直し、「Lofi Girl - christmas lofi radio 🎄 cozy ambience to relax to」になった
  - 終了したライブ配信（`live_status: post_live`）は、IINAで読み込めなかった

## 参照

- IINAプラグインドキュメント: <https://docs.iina.io/>
- <https://github.com/iina/iina>（v1.5.1タグ）
- <https://github.com/iina/iina-plugin-definition>、<https://github.com/iina/iina-plugin-template>
- <https://github.com/iina/plugin-opensub>、<https://github.com/mhajder/iina-jellyfin>
- <https://github.com/web-scrobbler/web-scrobbler>
- Last.fm API: <https://www.last.fm/api/desktopauth>、<https://www.last.fm/api/scrobbling>
