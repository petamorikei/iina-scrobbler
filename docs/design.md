# IINA Scrobbler 設計

2026-11-13時点の設計。根拠は`docs/research.md`（特に8章の実機確認）。【未確認】は実装前か実装中に確かめる項目。

## 0. 決定事項

2026-11-13、D1〜D4はすべて推奨案に決まった。

| #   | 論点                           | 決定                                                                                                                                                 | 採らなかった案                                                  |
| --- | ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| D1  | 連携（ログイン）の操作場所     | Pluginメニューの「Last.fmに接続…」（実機で動作確認済み）。設定画面には連携状態と手順を表示する                                                       | 設定画面のボタン（2.3の仕組み。要検証）                         |
| D2  | 再生元の分類                   | 「ローカルファイル」「yt-dlp経由」「その他のネットワーク（直接URL、ネットラジオ）」の3つにして、それぞれを切り替えられるようにする。既定はすべてオン | 2つにして、その他のネットワークを「ローカルファイル」側に含める |
| D3  | ネットラジオの曲ごとのscrobble | 初版では対応しない（ストリーム全体を1曲として扱うと誤ったscrobbleになるので、ネットラジオは送らない）。`icy-title`の実機確認後に対応する             | 初版から対応する                                                |
| D4  | 開発言語とビルド               | TypeScript＋esbuildで1ファイルずつ（main用、global用）出力する                                                                                       | プレーンなJavaScript（ビルドなし）                              |

補足:

- **D1**: 設定画面のHTMLが使えるのは`iina.preferences.get/set`だけで、プラグイン本体を直接呼べない（research.md 1.5）。ボタンを置くには2.3の間接的な仕組みが要るので採らない。
- **D3**: ネットラジオとライブ配信は送らない。判定は次のとおり（research.md 8.5.2）。
  - ネットラジオ: `metadata`に`icy-`で始まるキーがある。`duration`はバッファの長さで増え続けるので、長さでは見分けられない
  - ライブ配信: yt-dlpの結果で`is_live`が真
  - 念のため、`file-loaded`から数秒後に`duration`が変わり続けているものも送らない
- **D4**: TypeScriptにすると、IINAの型定義（誤りは手元で補う）を使え、Node上で判定ロジックの単体テストが書ける。バンドルすれば`require`のキャッシュの疑い（research.md 1.6）も避けられる。代わりに依存パッケージの導入とビルドの手順が増える。ツールとタスクはmise（`mise.toml`）、パッケージマネージャはpnpmで管理する。リントと整形はBiome、単体テストはVitest、コミット前の検査はprekで行う（`pnpm-template`に合わせた）。

## 1. 全体構成

|      | main entry（プレイヤーごとに1つ）                                             | global entry（プロセスに1つ）                                  |
| ---- | ----------------------------------------------------------------------------- | -------------------------------------------------------------- |
| 担当 | 再生元の判定、曲情報の取得（タグ、yt-dlp）、再生時間の積算とscrobble判定、OSD | 認証とsession key、送信キュー、Last.fmへの送信、Pluginメニュー |
| 通信 | 判定結果をJSON文字列でglobalへ送る                                            | mainへは返信しない                                             |

- global entryの読み込み中は`menu.forceUpdate()`を呼ばない。呼ぶとmain→globalのメッセージが届かなくなる（research.md 8.5.3）。
- 通信は**main→globalの一方向**を基本にする。global→mainの返信は8.1のクラッシュの原因になったので、初版では使わない。どうしても必要になったら、`setTimeout`で遅らせ、JSON文字列で送る（遅延とJSON文字列のどちらが効いたのかは切り分けていないので、両方守る）。
- 送信結果をOSDで知らせるには返信が要る。初版では、mainが自分で判定した時点（「scrobble対象になった」）でOSDを出し、送信の成否はOSDに出さない。送信の失敗はPluginメニューの表示（「未送信: 3件」など）で知らせる。

### 1.1 ソースの構成（D4で推奨案を採った場合）

```
src/
  main/
    index.ts          イベントの登録、ファイルごとの状態のリセット
    source.ts         再生元の判定（local / ytdlp / network）
    metadata/
      tags.ts         mpvのタグから曲情報を作る
      title-parser.ts media-titleの分割（web-scrobblerの区切り候補、processYtVideoTitle相当）
      ytdlp.ts        yt-dlpの実行と結果の解釈（チャプター→概要欄→タイトル＋チャンネル名）
    playback.ts       再生時間の積算、リピート検出、scrobble判定
  global/
    index.ts          メッセージの受信、メニュー
    auth.ts           認証フロー
    queue.ts          送信キュー（@data/queue.json）
  services/
    scrobbler.ts      サービス共通のインターフェース
    lastfm.ts         Last.fm（AudioScrobbler API）の実装
    md5.ts            純JSのMD5
  shared/
    messages.ts       main↔globalのメッセージの型
    prefs.ts          設定キーと既定値
    log.ts            ログ（token、session key、secretを出さない）
test/                 Node上の単体テスト（判定ロジック、タイトル分割、署名）
```

## 2. 認証

### 2.1 流れ

1. Pluginメニューの「Last.fmに接続…」を選ぶ
2. globalが`auth.getToken`（署名付き、GET）でtokenを取る
3. `utils.open("https://www.last.fm/api/auth/?api_key=…&token=…")`でブラウザを開く
4. 5秒ごとに`auth.getSession`を問い合わせる。error 14は「許可待ち」として続け、それ以外のエラーか10分経過で止める
5. 取れた`session.key`と`session.name`を`preferences`に保存し、`sync()`する

実機確認済み（research.md 8.5.1）。

### 2.2 解除と失効

- Pluginメニューの「Last.fmとの接続を解除」でsession keyとユーザー名を消す。キューは残す
- 送信時にerror 9（session keyが無効）が返ったら、session keyを消し、キューは残す。次に再生したときにOSDで再接続を促す

### 2.3 設定画面のボタン（D1で不採用。記録として残す）【未確認】

設定画面のボタンが`preferences.set("auth_request", <時刻>)`を書き、globalが1秒ごとに`preferences.get("auth_request")`を見て2.1を始める。設定画面は`preferences.get`を定期的に呼んで連携状態を表示する。成り立つかどうかは、globalから設定画面での変更がすぐ見えるか次第なので、確認用プラグインで確かめる。

## 3. 再生元の判定と切り替え（ユーザー要望）

### 3.1 分類

| 分類                 | 判定【未確認】                                                                                                                 | 設定キー           |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------ |
| ローカルファイル     | `path`がhttp(s)などのURLでない                                                                                                 | `scrobble_local`   |
| yt-dlp経由           | `path`がhttp(s)で、`iina.file-loaded`の時点で`stream-open-filename`が`path`と異なる（yt-dlpが実際のストリームURLに置き換えた） | `scrobble_ytdlp`   |
| その他のネットワーク | 上のどれにも当たらないURL（直接のメディアURL、ネットラジオ）                                                                   | `scrobble_network` |

- `iina.file-loaded`より前は`stream-open-filename`も`path`と同じ値なので、必ず`file-loaded`の時点で判定する
- 確認済み（research.md 8.4、8.5.2）: Online Media経由のYouTubeでは`stream-open-filename`がgooglevideoのURLに変わる。直接のメディアURLとネットラジオでは`path`と同じまま
- 未確認: mpv内蔵のytdl_hook経由の再生（この環境ではOnline Mediaを無効にすると再生できなかった）。Online Mediaが標準なので、初版はこの判定で進める

### 3.2 切り替えの振る舞い

- 設定はファイルを読み込むたびに読む（設定の変更イベントはない）。再生中に変えた場合は次のファイルから効く
- オフの分類では、nowPlayingもscrobbleも送らず、yt-dlpの実行もしない
- 切り替えても、すでにキューに入っているものは送る
- 「yt-dlp経由をscrobbleするか」（`scrobble_ytdlp`）と「曲情報の取得にyt-dlpを実行するか」（`ytdlp_metadata`、方式B）は別の設定にする。後者をオフにすると、yt-dlp経由の再生は`media-title`の分割（方式A）だけで曲情報を作る

## 4. 曲情報の取得

`iina.file-loaded`で取得する（`mpv.metadata.changed`はファイルが変わっても発火しない）。

### 4.1 ローカルファイル、その他のネットワーク

1. `metadata/by-key/`の`artist`、`title`、`album`、`album_artist`を読む（大文字小文字と`ALBUMARTIST`のような表記はffmpegが吸収する）
2. 動画（カバー画像ではない映像トラックがある）は、artistとtitleの両方のタグがあるときだけ送る。`Show Name - S01E01.mkv`のようなファイル名を曲として送らないため
3. 音声でartistかtitleが無ければ、ファイル名（`filename`）から拡張子と先頭のトラック番号（`05-`、`01. `など）を除き、区切り候補で分割して足りない側を補う。`:`、`/`、`|`、`~`はファイル名では区切りに使わない
4. それでもartistかtitleが取れなければ送らない（ログに理由を残す）

### 4.2 yt-dlp経由

1. `ytdlp_metadata`がオンなら、`utils.exec(<yt-dlpのパス>, ["-J", "--no-playlist", "--skip-download", "--no-warnings", "--ignore-no-formats-error", url])`を実行する（約1.8秒）。yt-dlpのパスは、設定の`ytdlp_path`、`/opt/homebrew/bin/yt-dlp`、`/usr/local/bin/yt-dlp`、IINA同梱の`youtube-dl`の順に探す
2. 結果から、次の順で最初にartistとtrackがそろったものを使う（`src/main/youtube.ts`）
   1. `artists`配列の**先頭**と`track`（YouTube Musicなどで入る）。`artist`は連結文字列なので使わない。2番目以降は作曲者などのクレジットで（実機では`["YOASOBI", "Ayase"]`）、連結するとLast.fmでは別のアーティストになるため使わない
   2. 概要欄の「Provided to YouTube by …」形式の解析（album付き。3つ目以降のアーティストは曲名に`(feat. …)`として付ける）
   3. タイトルの分割（web-scrobblerの`processYtVideoTitle`を移植）。artistが取れなければ、チャンネル名から「 - Topic」などを除いたもの。web-scrobblerと同じく、音楽以外の動画も「チャンネル名 - タイトル」として送られる。避けたい場合は`scrobble_ytdlp`をオフにする
   - web-scrobblerにあるチャプター名からの取得は、チャプター単位のscrobbleに対応しないので使わない
3. `title`が`youtube video #<id>`で他の項目がすべて`null`の結果は捨てる
4. yt-dlpが使えないか失敗したら（`ytdlp_metadata`がオフのときも）、`media-title`（動画タイトル）を同じ方法で分割する。チャンネル名がないので、タイトルにartistがなければ送らない
   - yt-dlpの結果は再生開始の2秒ほど後に届く。再生時間はファイル読み込み後の最初の`mpv.playback-restart`から数え、届くまでの分も記録の時刻に含める
   - yt-dlpの実行は30秒で打ち切る。`scrobble_ytdlp`がオフのときは実行しない
5. 長さは`duration`プロパティを使い、取れなければyt-dlpの`duration`を使う

チャプター単位のscrobble（1本の動画に複数曲が入っている場合）は初版では対応しない。

### 4.3 正規化

全フィールドにtrim、NBSPの置換、NFC正規化をかける（web-scrobblerと同じ）。

## 5. 再生時間の積算とscrobble判定

### 5.1 規則（web-scrobblerと同じ）

- 長さが30秒未満なら対象外
- `min(長さ×50%, 240秒)`だけ再生したらscrobbleする。長さが不明なら、ローカルファイルは30秒、ネットワーク（yt-dlp経由、その他）は対象外（D3）
- 時間は一時停止を除いた実際の経過時間（壁時計）で数える。シークで飛ばした分は数えない。倍速再生でも壁時計で数える
- timestampは再生を始めた時刻

### 5.2 積算の方法

- 1秒ごとの`setInterval`で`core.status`を読む。前回と今回の両方で再生中（一時停止中でもアイドル中でもない）なら、「前回からの壁時計の差」と「再生位置の進み（＋0.25秒の余裕）」の小さいほうを足す
  - タイマーが遅れても（macOSのタイマーの間引きなど）、再生位置が進んでいれば全部数える
  - シークで前に飛んでも壁時計の差しか数えず、後ろに戻ったときとスリープ中は数えない
  - 再生位置が取れないときは、1回あたり最大2秒
  - `mpv.time-pos.changed`は毎秒約17回発火するので、毎回処理すると無駄が大きい。積算には使わない
  - 読み込み直後は`mpv.pause.changed`と`core.status.paused`が食い違うことがある（research.md 8.2）。`core.status.paused`を正とし、`iina.file-loaded`から最初の`mpv.playback-restart`までは数えない
- ファイルごとに状態とタイマーをリセットする（PlayerCoreは使い回される）

### 5.3 リピートの検出

`loop-file`でのループでは`mpv.seek`と`mpv.playback-restart`だけが発火し、位置が0に戻る。ユーザーが先頭へシークした場合と区別するため、次の条件をすべて満たしたときだけ「新しい再生」とみなす。

- `mpv.seek`の直前の位置が`長さ - 3秒`以上だった
- シーク後の位置が3秒未満
- `loop-file`が`no`でない（`loop-playlist`で1曲だけの場合は`iina.file-loaded`が来るので、新しいファイルとして扱われる。research.md 8.5.2）

web-scrobblerの「経過時間が長さ以上になったら次の更新で新しい曲とみなす」という規則は、シークを含む再生で誤判定しやすいので採らない。

### 5.4 nowPlaying

- 曲情報がそろい、再生が始まったら1回送る
- 一時停止から再開したときに未送信なら送る。一時停止自体は通知しない
- scrobbleの対象外（30秒未満、分類がオフ）なら送らない

## 6. メッセージ（main→global）

ペイロードはすべてJSON文字列にする。

| 名前         | 内容                                                                  | globalの処理                                                     |
| ------------ | --------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `nowplaying` | `{artist, track, album?, albumArtist?, duration?}`                    | 接続済みなら`track.updateNowPlaying`を送る。失敗しても再送しない |
| `scrobble`   | `{artist, track, album?, albumArtist?, duration?, timestamp, source}` | キューに入れてから送信を試みる                                   |

## 7. 送信キュー

- `@data/queue.json`に保存する。項目には一意のIDを付ける
- 送信は`track.scrobble`で最大50件ずつ。成功したらキューから消す
- エラーの扱い:

| 種類                         | 処理                                                                                                                                                                    |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 成功（200）                  | 消す。曲ごとの`ignoredMessage.code`が`"0"`以外なら、無視された理由をログに残す。ただし`"5"`（1日の上限）は残して再送する（応答の形は実機で確認済み。research.md 8.5.5） |
| error 9                      | session keyを消してキューは残す（2.2）                                                                                                                                  |
| error 11、16、29、通信の失敗 | 残して後で再送。間隔は1分から始めて倍にし、最大1時間                                                                                                                    |
| それ以外（6、13など）        | ログに残して消す（再送しても通らない）                                                                                                                                  |

- 再送のきっかけ: IINAの起動時（3秒後）、新しいscrobbleが入ったとき、再送の時刻が来たとき、Last.fmと連携したとき、Pluginメニューの「Send pending scrobbles now」
- 未連携のときもscrobbleはキューに入れ、連携した時点で送る
- Pluginメニューに未送信の件数（「Pending scrobbles: N」）と、次の再送までの時間を出す
- 14日より古い項目は捨てる（Last.fmが古いtimestampを拒否するため。期間は【未確認】）
- **複数プロセスの問題（未解決のリスク）**: IINAのプロセスが2つ起動すると、global entryも2つ動き、同じ`@data/queue.json`を読み書きする。書き込み直前に読み直して項目IDで統合すれば消失は減らせるが、二重送信は防げない。初版はこの対策だけにして、二重送信の可能性を既知の制限として残す

## 8. 設定項目

| キー               | 型     | 既定値           | 設定画面                                                                                                           |
| ------------------ | ------ | ---------------- | ------------------------------------------------------------------------------------------------------------------ |
| `session_key`      | 文字列 | 空               | 表示しない                                                                                                         |
| `session_name`     | 文字列 | 空               | 連携中のユーザー名を表示                                                                                           |
| `scrobble_local`   | 真偽値 | true             | チェックボックス                                                                                                   |
| `scrobble_ytdlp`   | 真偽値 | true             | チェックボックス                                                                                                   |
| `scrobble_network` | 真偽値 | true             | チェックボックス                                                                                                   |
| `ytdlp_metadata`   | 真偽値 | true             | チェックボックス                                                                                                   |
| `ytdlp_path`       | 文字列 | 空（自動で探す） | テキスト欄                                                                                                         |
| `show_osd`         | 真偽値 | true             | チェックボックス                                                                                                   |
| `debug_log`        | 真偽値 | false            | チェックボックス（不具合の報告用。オンにすると、プラグインのデータフォルダに`debug-<main/global>-<ID>.log`を書く） |

- 設定画面のチェックボックスは`data-pref-key`で自動的に真偽値として保存される（IINAのソース`PrefPluginViewController.swift`で確認）。テキスト欄はフォーカスが外れたときに保存される
- API keyとsecretは設定に置かず、ビルド時にソースへ埋め込む

## 9. 他のサービスへの拡張

web-scrobblerの`BaseScrobbler`に倣い、サービスごとに次のインターフェースを実装する。初版はLast.fmだけ。Libre.fmはURLとkeyを替えるだけで同じ実装を使える。

```ts
interface Scrobbler {
  id: string; // "lastfm"
  isConnected(): boolean;
  connect(): Promise<void>; // 認証フロー
  disconnect(): void;
  nowPlaying(t: Track): Promise<Result>;
  scrobble(ts: Track[]): Promise<Result[]>; // 1件ごとの結果
}
type Result = "ok" | "ignored" | "auth-error" | "retry" | "drop";
```

キューの項目はサービスごとに持つ（`{id, service, track, timestamp, attempts}`）。

## 10. 確認の状況

実装前の確認は済んだ（research.md 8.5.2）。残りは実装中に確かめる。

- 再生中に停止すると`mpv.end-file`→`mpv.idle`→`iina.window-will-close`の順に来る。mainは`mpv.end-file`と`mpv.idle`で、そのファイルの状態を捨てる（scrobble済みでなければ送らない）
- ウィンドウを手で閉じたときの順序は未確認（停止と同じと推測）
- mpv内蔵ytdl_hook経由の再生元の判定は未確認

## 11. 実装の順序

1. 雛形とビルド（D4）、MD5と署名の単体テスト
2. global: 認証、nowPlaying、scrobble（キューなし）
3. main: ローカルファイルの曲情報、積算、判定、メッセージ
4. 送信キューと再送
5. 再生元の判定と切り替え、yt-dlpによる曲情報
6. 設定画面、OSD、Pluginメニューの状態表示
