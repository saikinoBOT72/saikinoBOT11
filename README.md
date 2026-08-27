# saikinoBOT11

身内サーバー向けの Discord Bot。**サーバー内通貨**を軸に、

- 筋トレなどの**アクション報告でコインを稼ぎ**、
- **スロット / コイントス / じゃんけん対戦**で増やしたり溶かしたり、
- **各自が画像と値段を設定して出品できるショップ**で売り買いする

までを一通り揃えています。特権インテント（Message Content など）は不要です。

## 使い方は `/menu` だけ

コマンドを覚える必要はありません。**`/menu` と打つとボタン付きのメニューが開き、そこから全部の操作ができます。**

```
🏠 メニュー
所持金 🪙 1,250 コイン （3 位）

[💪 報告してかせぐ] [🎮 あそぶ] [🛍️ ショップ]
[💰 お財布]        [🏆 ランキング] [🎒 持ち物]
[❓ 使い方]        [🔄 更新]      [⚙️ 管理]
```

- 報告は**リストから選ぶだけ**。クールダウン中のものは「⏳休憩中」と表示されます
- 賭け金は **10 / 50 / 100 / 500 / 1000 のボタン**か、「⌨️ 金額を入力」で自由入力
- じゃんけんの相手、送金相手は**メンバー一覧から選択**
- 出品・編集・通貨設定などの入力は**フォーム（モーダル）**で入力
- メニューは押した本人にしか見えないので、チャンネルが荒れません（報告・購入・送金など、みんなに知らせたいものだけ自動でチャンネルに投稿されます）

もちろん下記のスラッシュコマンドも今までどおり使えます。

---

## できること

### 💪 コインを稼ぐ

メニュー: **💪 報告してかせぐ** → アクションを選ぶだけ

| コマンド | 説明 |
| --- | --- |
| `/report do activity:筋トレ note:… proof:<画像>` | アクションを報告してコイン獲得 |
| `/report list` | 報告できるアクションと報酬の一覧 |
| `/report stats [user]` | これまでの報告回数と獲得額 |

アクションは管理者が自由に定義できます（`/activity add`）。それぞれに

- 報酬額
- クールダウン（例: 6時間に1回まで）
- 1日の上限回数
- 画像の添付を必須にするか

を設定でき、自己申告でも荒れにくいようになっています。`/activity preset` で「筋トレ・ランニング・勉強・早起き・自炊」を一括登録できます。

### 🎮 遊ぶ

メニュー: **🎮 あそぶ** → スロット / コイントス / じゃんけん

| コマンド | 説明 |
| --- | --- |
| `/slot play bet:100` | スロット。3つ揃いで最大 x3000（`/slot table` で配当表） |
| `/coinflip side:表 bet:100` | コイントス。当たれば賭け金が2倍 |
| `/rps opponent:@誰か bet:100` | じゃんけん対戦。ボタンで手を選び、勝者が総取り |

じゃんけんは「挑戦 → 相手が承諾 → 双方がボタンで手を選ぶ」流れです。手は相手に見えず、あいこなら再戦、5回続けば引き分け返金。時間切れや Bot の再起動があっても賭け金は自動で返金されます。

スロットの還元率は約 91%（残りはサーバーの取り分＝インフレ防止）。コイントスは等倍で公平です。

### 🛍️ 売り買いする

メニュー: **🛍️ ショップ** → 一覧から選んで購入、「🆕 出品する」で出品

| コマンド | 説明 |
| --- | --- |
| `/shop sell name:肩たたき券 price:500 image:<画像> stock:3` | 誰でも出品できる。画像はアップロードでもURLでも可 |
| `/shop list [page] [seller]` | 出品一覧 |
| `/shop show id:1` | 商品の詳細と画像 |
| `/shop buy id:1` | 購入（確認ボタンつき）。代金は出品者に直接入る |
| `/shop edit id:1 price:400` | 自分の出品の価格・説明・在庫・画像を変更 |
| `/shop remove id:1` | 出品を取り下げ（管理者は他人の出品も可） |
| `/inventory [user]` | 買ったもの・売れたものの一覧 |

在庫は未指定なら無制限、指定すれば売り切れで自動的に販売停止になります。アップロードされた画像は Discord の添付URLが期限切れになるため、Bot 側（`data/images/`）に保存して表示のたびに貼り直します。

#### メニューから画像を付けるとき

メニューの「🖼️ 画像を付ける」や写真必須アクションの報告では、Bot が画像の到着を3分間待ちます。初期設定では **Bot をメンションして画像を送る**必要があります（Discord の仕様で、メンションされていないメッセージの添付ファイルは読めないため）。

`.env` の `MESSAGE_CONTENT_INTENT=true` にして、Developer Portal の Bot ページで **Message Content Intent** を ON にすると、メンション無しで画像を送るだけで済むようになります。

### 💰 お金まわり・管理

メニュー: **💰 お財布**、管理は **⚙️ 管理**

| コマンド | 説明 |
| --- | --- |
| `/menu` | ボタン操作のメニューを開く |
| `/balance [user]` | 所持金・サーバー順位・累計収支 |
| `/pay user:@誰か amount:100 memo:…` | 送金 |
| `/leaderboard [count]` | 所持金ランキング |
| `/help` | 使い方の一覧 |
| `/economy give / take / set` | 管理者が残高を調整 |
| `/economy config` | 通貨名・絵文字・初期残高・賭け金の下限/上限を設定 |
| `/economy history user:@誰か` | コインの増減履歴（不具合調査用） |

管理系コマンド（`/activity`・`/economy`）は「サーバー管理」権限を持つ人だけに表示されます。

---

## セットアップ

### 1. Bot を作る

1. [Discord Developer Portal](https://discord.com/developers/applications) で **New Application**。
2. **Bot** タブでトークンを発行（`DISCORD_TOKEN`）。特権インテントは不要です。
3. **OAuth2 → URL Generator** で以下を選び、生成されたURLからサーバーに招待します。
   - スコープ: `bot`, `applications.commands`
   - 権限: `View Channels` / `Send Messages` / `Embed Links` / `Attach Files` / `Read Message History` / `Add Reactions`

### 2. 動かす

```bash
git clone <このリポジトリ>
cd saikinoBOT11
npm install

cp .env.example .env
# .env に DISCORD_TOKEN と CLIENT_ID（Application ID）を記入
# 身内サーバーのIDを GUILD_ID に入れておくとコマンドが即反映されます

npm run deploy   # スラッシュコマンドを登録（コマンドを増減したときだけ実行）
npm start        # Bot 起動
```

起動したらサーバーで **`/menu`** を実行してみてください。まずは管理者がメニューの **⚙️ 管理 → 📋 アクション管理 → 📦 おすすめを一括登録**（または `/activity preset`）を実行すると、すぐに報告して稼げるようになります。

`npm run deploy` は必須ではありません。**起動時にコマンドの内容が変わっていれば自動で登録し直します**（`data/commands.hash` で判定）。手動で登録し直したいときだけ使ってください。

### 3. 常時稼働させる

Bot はプロセスが動いている間だけ反応します。PCを閉じれば止まるので、置き場所を決める必要があります。

#### Docker（VPS・自宅サーバー・ラズパイ共通、おすすめ）

```bash
cp .env.example .env    # トークンなどを記入
docker compose up -d    # 起動
docker compose logs -f  # ログを見る
docker compose pull && docker compose up -d --build   # 更新するとき
```

`data/` をホスト側にマウントしているので、コンテナを作り直しても残高やアイテムは消えません。

#### systemd（Docker を使わない場合）

`deploy/saikinobot.service` を使います。ファイル冒頭のコメントに手順を書いてあります。

```bash
sudo cp deploy/saikinobot.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now saikinobot
journalctl -u saikinobot -f
```

#### pm2（手軽に済ませたい場合）

```bash
npm install -g pm2
pm2 start npm --name saikinobot -- start
pm2 save && pm2 startup
```

---

## データについて

- 残高・報告履歴・ショップ・購入履歴はすべて `data/economy.db`（SQLite）に入ります。
- 出品画像は `data/images/` に保存されます。
- **バックアップはこの `data/` ディレクトリを丸ごとコピーすれば OK**です（`.gitignore` 済み）。
- コインの増減はすべて `ledger` テーブルに記録されるので、おかしくなったら `/economy history` で追跡できます。
- データはサーバー（ギルド）ごとに完全に分かれています。

Docker で動かす場合は `data/` がそのままホスト側に見えます。環境変数で保存先やタイムゾーンを変えられます（`.env.example` 参照）。「1日の上限回数」は `TZ`（初期値 `Asia/Tokyo`）の日付で判定します。

---

## 開発

```bash
npm test    # Discord に接続せずに検証（69件）
```

テストは2種類あります。

- `test/run-tests.mjs` — 通貨・報告・ショップ・じゃんけん・スロットのロジック
- `test/menu-tests.mjs` — 偽のインタラクションでメニューを操作し、**押しても反応しないボタンが無いか**と、実際にコインやアイテムが正しく動くかを確認

コマンドを追加するときは `src/commands/` に `data`（SlashCommandBuilder）と `execute` を export するファイルを置くだけで自動的に読み込まれます。ボタンを使う場合は `namespace` と `handleComponent` も export してください（customId を `<namespace>:...` の形式にします）。

```
src/
  index.js            Bot 本体（インタラクションの振り分け）
  deploy-commands.js  スラッシュコマンドの登録
  commands/           各スラッシュコマンド
  menu/               `/menu` の画面（ボタン・セレクト・入力フォーム）
    router.js         customId `m:<画面>:<操作>:<引数>` の振り分け
    home.js           トップ画面
    report.js         報告
    games.js          スロット・コイントス・じゃんけん
    shop.js           ショップ（出品・購入・編集）
    wallet.js         所持金・送金・履歴・ランキング
    admin.js          管理メニュー
    upload.js         画像の受け取り
  lib/
    db.js             SQLite とスキーマ
    economy.js        残高・送金・台帳
    activities.js     報告アクションとクールダウン
    shop.js           出品・購入（在庫と送金を1トランザクションで処理）
    rps.js            じゃんけんの状態管理と返金
    slot.js           スロットの出目と配当
    images.js         出品画像の保存と表示
```
