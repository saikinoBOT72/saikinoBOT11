-- Bot の中で変えられる設定と、それを支える表。

-- 【サーバーごとの設定】
-- day_start_hour  … 1日の区切り（0〜23）。NULL なら wrangler.jsonc の DAY_START_HOUR を使う
-- game_channel_id … 卓や挑戦状を出すチャンネル。NULL なら押した場所に出す
-- solo_private    … 1人で遊ぶブラックジャック・ヨットの練習を、チャンネルに出さず本人の画面だけで進める
-- fold_finished   … 決着した卓・勝負の掲示を、結果の1行だけに畳む
-- live_threshold  … この額以上の勝ち負けを実況する（0 で実況しない。大当たりは別）
-- live_channel_id … 実況を出すチャンネル。NULL なら遊んだ場所に出す
ALTER TABLE guild_settings ADD COLUMN day_start_hour INTEGER;
ALTER TABLE guild_settings ADD COLUMN game_channel_id TEXT;
ALTER TABLE guild_settings ADD COLUMN solo_private INTEGER NOT NULL DEFAULT 0;
ALTER TABLE guild_settings ADD COLUMN fold_finished INTEGER NOT NULL DEFAULT 0;
ALTER TABLE guild_settings ADD COLUMN live_threshold INTEGER NOT NULL DEFAULT 0;
ALTER TABLE guild_settings ADD COLUMN live_channel_id TEXT;

-- 【時間切れの1分前の催促】
-- 同じ締切に二度催促しないための印。締切が延びれば（誰かが動けば）別の行になる。
CREATE TABLE IF NOT EXISTS nudges (
  kind       TEXT    NOT NULL,   -- duel / rps / chinchiro / blackjack / poker / pig / yacht
  target_id  TEXT    NOT NULL,
  deadline   INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (kind, target_id, deadline)
);

-- 【Bot 全体の小さな記録】いま動いている版など。
CREATE TABLE IF NOT EXISTS app_state (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- 【遊び方を読んだか】2回目からはルールの説明を畳むため。
CREATE TABLE IF NOT EXISTS seen_rules (
  guild_id TEXT NOT NULL,
  user_id  TEXT NOT NULL,
  game     TEXT NOT NULL,
  seen_at  INTEGER NOT NULL,
  PRIMARY KEY (guild_id, user_id, game)
);

-- 【終わった卓を畳む】
-- 決着してから少し置いて（結果を読む時間を残して）、掲示を結果の1行に畳む。
-- 畳んだら消す。中身は「結果の1行」だけ。
CREATE TABLE IF NOT EXISTS fold_queue (
  message_id TEXT    PRIMARY KEY,
  channel_id TEXT    NOT NULL,
  guild_id   TEXT    NOT NULL,
  summary    TEXT    NOT NULL,
  fold_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_fold_due ON fold_queue (fold_at);
